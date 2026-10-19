// Host-side test: signs a reading with the firmware crypto core + micro-ecc and prints
// JSON that test_firmware.py checks against the Python/Solidity implementation.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../voltproof_meter/voltproof_crypto.h"
#include "uECC.h"

static int rng(uint8_t *dest, unsigned size) {
    for (unsigned i = 0; i < size; i++) dest[i] = (uint8_t)(rand() & 0xff);
    return 1;
}

static void unhex(const char *h, uint8_t *out, size_t n) {
    if (h[0] == '0' && h[1] == 'x') h += 2;
    for (size_t i = 0; i < n; i++) sscanf(h + 2 * i, "%2hhx", &out[i]);
}

int main(int argc, char **argv) {
    if (argc < 7) {
        fprintf(stderr, "usage: privkey chainId contract hourStart energyWh nonce\n");
        return 1;
    }
    srand(1234);
    uECC_set_rng(rng);
    const struct uECC_Curve_t *curve = uECC_secp256k1();
    uint8_t priv[32], pub[64], contract[20], dom[32], digest[32], sig[64];
    unhex(argv[1], priv, 32);
    unhex(argv[3], contract, 20);
    if (!uECC_compute_public_key(priv, pub, curve)) return 2;

    vp_reading_t r;
    vp_address_from_pubkey(pub, r.device);
    r.hour_start = strtoull(argv[4], 0, 10);
    r.energy_wh = strtoull(argv[5], 0, 10);
    r.nonce = strtoull(argv[6], 0, 10);

    vp_domain_separator(strtoull(argv[2], 0, 10), contract, dom);
    vp_reading_digest(dom, &r, digest);

    int ok = 0;
    for (int tries = 0; tries < 64 && !ok; tries++) {  // generate many sigs → exercises high-s path
        if (!uECC_sign(priv, digest, 32, sig, curve)) return 3;
        uint8_t before = sig[32];
        vp_normalize_low_s(sig);
        ok = (before > 0x7f) || tries == 63;
    }

    char a[43], d[67], ds[67], s[131];
    vp_to_hex(r.device, 20, a);
    vp_to_hex(digest, 32, d);
    vp_to_hex(dom, 32, ds);
    vp_to_hex(sig, 64, s);
    printf("{\"address\":\"%s\",\"domainSeparator\":\"%s\",\"digest\":\"%s\",\"signature\":\"%s\"}\n", a, ds, d, s);
    return 0;
}
