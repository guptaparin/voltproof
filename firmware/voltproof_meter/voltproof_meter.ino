/*
 * VoltProof Meter — ESP32 + INA219 reference firmware
 * ----------------------------------------------------
 * Measures a solar panel's output, integrates energy over each UTC hour, signs the
 * reading with a key that never leaves the device (EIP-712, secp256k1) and posts it
 * to a VoltProof verifier. The contract will only ever mint certificates for readings
 * this key signed.
 *
 * Hardware:   ESP32 DevKit + INA219 breakout (I2C: SDA=21, SCL=22) in series with the
 *             panel's output into a load / charge controller.
 * Libraries:  Adafruit INA219 (Library Manager) and micro-ecc (copied in by setup.sh).
 * Production: enable ESP32 Secure Boot v2 + Flash Encryption so the key in NVS cannot
 *             be read out, or move the key into an ATECC608 secure element.
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <Wire.h>
#include <time.h>
#include <esp_random.h>
#include <Adafruit_INA219.h>

extern "C" {
#include "uECC.h"
#include "voltproof_crypto.h"
}

// ───────────────────────────── configuration ─────────────────────────────
static const char *WIFI_SSID = "YOUR_WIFI";
static const char *WIFI_PASS = "YOUR_PASSWORD";
static const char *VERIFIER_URL = "http://192.168.1.10:8000/v1/readings";  // your laptop's LAN IP
static const uint64_t CHAIN_ID = 31337;                                     // 80002 for Polygon Amoy
static const char *CERT_CONTRACT = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";  // from deployments/current.json
static const float SAMPLE_PERIOD_S = 1.0f;

// ─────────────────────────────── state ───────────────────────────────────
Adafruit_INA219 ina;
Preferences nvs;
static uint8_t priv[32], pub[64], device[20], domainSep[32];
static double hourWh = 0;
static uint64_t currentHour = 0;
static uint64_t nonce = 0;
static const struct uECC_Curve_t *curve;

static int esp_rng(uint8_t *dest, unsigned size) {
  esp_fill_random(dest, size);  // hardware TRNG
  return 1;
}

static void unhex(const char *h, uint8_t *out, size_t n) {
  if (h[0] == '0' && h[1] == 'x') h += 2;
  for (size_t i = 0; i < n; i++) {
    char b[3] = {h[2 * i], h[2 * i + 1], 0};
    out[i] = (uint8_t)strtoul(b, nullptr, 16);
  }
}

static uint64_t nowUtc() { return (uint64_t)time(nullptr); }

static void loadOrCreateKey() {
  nvs.begin("voltproof", false);
  if (nvs.getBytesLength("priv") == 32) {
    nvs.getBytes("priv", priv, 32);
  } else {
    // Key is generated ON the device and never exported.
    if (!uECC_make_key(pub, priv, curve)) { Serial.println("keygen failed"); while (true) delay(1000); }
    nvs.putBytes("priv", priv, 32);
  }
  uECC_compute_public_key(priv, pub, curve);
  vp_address_from_pubkey(pub, device);
  nonce = nvs.getULong64("nonce", 0);
}

static bool postReading(uint64_t hourStart, uint64_t energyWh) {
  vp_reading_t r;
  memcpy(r.device, device, 20);
  r.hour_start = hourStart;
  r.energy_wh = energyWh;
  r.nonce = nonce + 1;

  uint8_t digest[32], sig[64];
  vp_reading_digest(domainSep, &r, digest);
  if (!uECC_sign(priv, digest, 32, sig, curve)) return false;
  vp_normalize_low_s(sig);

  char addrHex[43], sigHex[131];
  vp_to_hex(device, 20, addrHex);
  vp_to_hex(sig, 64, sigHex);  // 64-byte (r,s); the verifier derives v
  char body[420];
  snprintf(body, sizeof body,
           "{\"reading\":{\"device\":\"%s\",\"hourStart\":%llu,\"energyWh\":%llu,\"nonce\":%llu},\"signature\":\"%s\"}",
           addrHex, (unsigned long long)hourStart, (unsigned long long)energyWh, (unsigned long long)r.nonce, sigHex);

  HTTPClient http;
  http.begin(VERIFIER_URL);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  String resp = http.getString();
  http.end();
  Serial.printf("[%llu] %llu Wh signed → HTTP %d\n", (unsigned long long)hourStart, (unsigned long long)energyWh, code);
  if (code == 200) {
    int i = resp.indexOf("\"status\":\"");
    if (i >= 0) Serial.printf("  verdict: %s\n", resp.substring(i + 10, resp.indexOf('"', i + 10)).c_str());
    nonce = r.nonce;  // consume the nonce only once the verifier has recorded it
    nvs.putULong64("nonce", nonce);
    return true;
  }
  return false;
}

static void queuePending(uint64_t hourStart, uint64_t wh) {  // store-and-forward if offline
  nvs.putULong64("pend_h", hourStart);
  nvs.putULong64("pend_e", wh);
}

static void flushPending() {
  uint64_t h = nvs.getULong64("pend_h", 0);
  if (!h || WiFi.status() != WL_CONNECTED) return;
  if (postReading(h, nvs.getULong64("pend_e", 0))) nvs.putULong64("pend_h", 0);
}

void setup() {
  Serial.begin(115200);
  delay(300);
  curve = uECC_secp256k1();
  uECC_set_rng(esp_rng);
  loadOrCreateKey();

  uint8_t contract[20];
  unhex(CERT_CONTRACT, contract, 20);
  vp_domain_separator(CHAIN_ID, contract, domainSep);

  char addrHex[43];
  vp_to_hex(device, 20, addrHex);
  Serial.printf("\nVoltProof meter %s\nRegister this address on-chain before readings will count.\n", addrHex);

  Wire.begin(21, 22);
  if (!ina.begin()) { Serial.println("INA219 not found"); while (true) delay(1000); }

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print('.'); }
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  while (nowUtc() < 1700000000ULL) delay(200);
  currentHour = nowUtc() - nowUtc() % 3600;
  Serial.println("\nonline, time synced");
}

void loop() {
  static uint32_t last = millis();
  if (millis() - last >= (uint32_t)(SAMPLE_PERIOD_S * 1000)) {
    float dt = (millis() - last) / 1000.0f;
    last = millis();
    float watts = max(0.0f, ina.getBusVoltage_V() * ina.getCurrent_mA() / 1000.0f);
    hourWh += watts * dt / 3600.0;
  }

  uint64_t h = nowUtc() - nowUtc() % 3600;
  if (h != currentHour) {  // the hour just finished → sign and submit it
    uint64_t wh = (uint64_t)(hourWh + 0.5);
    if (wh > 0 && !postReading(currentHour, wh)) queuePending(currentHour, wh);
    currentHour = h;
    hourWh = 0;
  }
  flushPending();
  delay(20);
}
