# VoltProof meter firmware (ESP32 + INA219)

The meter generates its own secp256k1 key on first boot, integrates panel output over each
UTC hour, signs the reading with EIP-712 and posts it to the verifier. The signature is the
only thing that makes a reading count: the smart contract recovers the signer and checks it
against the on-chain device registry.

## Wiring

| INA219 | ESP32 |
|---|---|
| VCC | 3V3 |
| GND | GND |
| SDA | GPIO 21 |
| SCL | GPIO 22 |
| VIN+ / VIN− | in series with the panel's positive lead, before the load or charge controller |

## Build

```bash
./setup.sh                      # copies micro-ecc into the sketch folder
```

1. Open `voltproof_meter/voltproof_meter.ino` in Arduino IDE 2.x with the ESP32 board package.
2. Install **Adafruit INA219** from the Library Manager.
3. Set `WIFI_SSID`, `WIFI_PASS`, `VERIFIER_URL` (your laptop's LAN IP, port 8000),
   `CHAIN_ID` and `CERT_CONTRACT` from `deployments/current.json`.
4. Flash and open the serial monitor at 115200 baud. Note the printed meter address.
5. Register it, using the panel's real nameplate wattage:

```bash
cd contracts
DEVICE=0x... CAPACITY_W=10 LAT=30.3525 LON=76.3616 NAME="My panel" \
  npx hardhat run scripts/register-device.js --network localhost
```

At every hour boundary the meter prints the signed reading and the verifier's verdict.

## Verified crypto

`test/test_firmware.py` compiles the same C crypto core for your computer and checks
25 random vectors against the Python reference used by the verifier (which matches the
Solidity contract's tests). It checks the address derivation, EIP-712 domain separator,
digest, signature recovery and low-s normalisation.

```bash
python firmware/test/test_firmware.py
```

## Hardening for production

- Enable **Secure Boot v2** and **Flash Encryption** so the NVS key cannot be dumped, or
  store the key in an **ATECC608** secure element so it can never be exported.
- Add a tamper switch on the enclosure. On a trigger, wipe the key; the registrar then
  revokes the meter on-chain (`DeviceRegistry.setActive(device, false, reason)`).
- Pending readings are kept in NVS and retried, so a Wi-Fi outage does not lose energy.
