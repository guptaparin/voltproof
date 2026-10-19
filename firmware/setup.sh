#!/usr/bin/env bash
# Copies the micro-ecc library (BSD-2) into the Arduino sketch folder.
set -euo pipefail
cd "$(dirname "$0")"
[ -d third_party/micro-ecc ] || git clone --depth 1 https://github.com/kmackay/micro-ecc.git third_party/micro-ecc
cp third_party/micro-ecc/uECC.c third_party/micro-ecc/uECC.h third_party/micro-ecc/uECC_vli.h \
   third_party/micro-ecc/types.h third_party/micro-ecc/platform-specific.inc \
   third_party/micro-ecc/curve-specific.inc third_party/micro-ecc/asm_*.inc voltproof_meter/
echo "micro-ecc copied into voltproof_meter/. Open voltproof_meter.ino in Arduino IDE."
