// VoltProof meter crypto core — portable C, no heap, no dependencies beyond micro-ecc.
// Computes the exact EIP-712 digest the GranularCertificate contract verifies.
#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint8_t device[20];
    uint64_t hour_start;
    uint64_t energy_wh;
    uint64_t nonce;
} vp_reading_t;

// Ethereum Keccak-256 (original Keccak padding, not FIPS-202 SHA3).
void vp_keccak256(const uint8_t *in, size_t len, uint8_t out[32]);

// keccak256(abi.encode(EIP712Domain typehash, "VoltProof", "1", chainId, verifyingContract))
void vp_domain_separator(uint64_t chain_id, const uint8_t contract[20], uint8_t out[32]);

// keccak256(abi.encode(READING_TYPEHASH, device, hourStart, energyWh, nonce))
void vp_reading_struct_hash(const vp_reading_t *r, uint8_t out[32]);

// keccak256(0x1901 || domainSeparator || structHash)
void vp_reading_digest(const uint8_t domain_sep[32], const vp_reading_t *r, uint8_t out[32]);

// Ethereum address from a 64-byte uncompressed public key (x||y, no 0x04 prefix).
void vp_address_from_pubkey(const uint8_t pub[64], uint8_t addr[20]);

// Enforce low-s (s <= n/2) as required by OpenZeppelin ECDSA. sig = r(32)||s(32).
void vp_normalize_low_s(uint8_t sig[64]);

void vp_to_hex(const uint8_t *in, size_t len, char *out /* 2*len+3 incl. 0x and NUL */);

#ifdef __cplusplus
}
#endif
