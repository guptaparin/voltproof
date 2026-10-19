#include "voltproof_crypto.h"
#include <string.h>

// ───────────────────────────── Keccak-f[1600] ─────────────────────────────
static const uint64_t RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL, 0x8000000080008000ULL,
    0x000000000000808bULL, 0x0000000080000001ULL, 0x8000000080008081ULL, 0x8000000000008009ULL,
    0x000000000000008aULL, 0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL, 0x8000000000008003ULL,
    0x8000000000008002ULL, 0x8000000000000080ULL, 0x000000000000800aULL, 0x800000008000000aULL,
    0x8000000080008081ULL, 0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL};
static const int ROTC[24] = {1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44};
static const int PILN[24] = {10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1};

#define ROTL64(x, y) (((x) << (y)) | ((x) >> (64 - (y))))

static void keccakf(uint64_t st[25]) {
    uint64_t bc[5], t;
    for (int round = 0; round < 24; round++) {
        for (int i = 0; i < 5; i++) bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
        for (int i = 0; i < 5; i++) {
            t = bc[(i + 4) % 5] ^ ROTL64(bc[(i + 1) % 5], 1);
            for (int j = 0; j < 25; j += 5) st[j + i] ^= t;
        }
        t = st[1];
        for (int i = 0; i < 24; i++) {
            int j = PILN[i];
            bc[0] = st[j];
            st[j] = ROTL64(t, ROTC[i]);
            t = bc[0];
        }
        for (int j = 0; j < 25; j += 5) {
            for (int i = 0; i < 5; i++) bc[i] = st[j + i];
            for (int i = 0; i < 5; i++) st[j + i] ^= (~bc[(i + 1) % 5]) & bc[(i + 2) % 5];
        }
        st[0] ^= RC[round];
    }
}

void vp_keccak256(const uint8_t *in, size_t len, uint8_t out[32]) {
    uint64_t st[25];
    uint8_t *s = (uint8_t *)st;  // little-endian lanes (ESP32 and x86 are LE)
    const size_t rate = 136;
    memset(st, 0, sizeof st);
    while (len >= rate) {
        for (size_t i = 0; i < rate; i++) s[i] ^= in[i];
        keccakf(st);
        in += rate;
        len -= rate;
    }
    for (size_t i = 0; i < len; i++) s[i] ^= in[i];
    s[len] ^= 0x01;
    s[rate - 1] ^= 0x80;
    keccakf(st);
    memcpy(out, s, 32);
}

// ───────────────────────────── ABI helpers ─────────────────────────────
static void put_u64_word(uint8_t w[32], uint64_t v) {
    memset(w, 0, 32);
    for (int i = 0; i < 8; i++) w[31 - i] = (uint8_t)(v >> (8 * i));
}
static void put_addr_word(uint8_t w[32], const uint8_t a[20]) {
    memset(w, 0, 12);
    memcpy(w + 12, a, 20);
}
static void hash_str(const char *s, uint8_t out[32]) { vp_keccak256((const uint8_t *)s, strlen(s), out); }

void vp_domain_separator(uint64_t chain_id, const uint8_t contract[20], uint8_t out[32]) {
    uint8_t buf[5 * 32];
    hash_str("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)", buf);
    hash_str("VoltProof", buf + 32);
    hash_str("1", buf + 64);
    put_u64_word(buf + 96, chain_id);
    put_addr_word(buf + 128, contract);
    vp_keccak256(buf, sizeof buf, out);
}

void vp_reading_struct_hash(const vp_reading_t *r, uint8_t out[32]) {
    uint8_t buf[5 * 32];
    hash_str("Reading(address device,uint64 hourStart,uint64 energyWh,uint64 nonce)", buf);
    put_addr_word(buf + 32, r->device);
    put_u64_word(buf + 64, r->hour_start);
    put_u64_word(buf + 96, r->energy_wh);
    put_u64_word(buf + 128, r->nonce);
    vp_keccak256(buf, sizeof buf, out);
}

void vp_reading_digest(const uint8_t domain_sep[32], const vp_reading_t *r, uint8_t out[32]) {
    uint8_t buf[66];
    buf[0] = 0x19;
    buf[1] = 0x01;
    memcpy(buf + 2, domain_sep, 32);
    vp_reading_struct_hash(r, buf + 34);
    vp_keccak256(buf, sizeof buf, out);
}

void vp_address_from_pubkey(const uint8_t pub[64], uint8_t addr[20]) {
    uint8_t h[32];
    vp_keccak256(pub, 64, h);
    memcpy(addr, h + 12, 20);
}

// secp256k1 group order n and n/2 (big-endian)
static const uint8_t N[32] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE,
                              0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B, 0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36, 0x41, 0x41};
static const uint8_t HALF_N[32] = {0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
                                   0x5D, 0x57, 0x6E, 0x73, 0x57, 0xA4, 0x50, 0x1D, 0xDF, 0xE9, 0x2F, 0x46, 0x68, 0x1B, 0x20, 0xA0};

void vp_normalize_low_s(uint8_t sig[64]) {
    uint8_t *s = sig + 32;
    if (memcmp(s, HALF_N, 32) <= 0) return;
    int borrow = 0;
    for (int i = 31; i >= 0; i--) {
        int d = (int)N[i] - (int)s[i] - borrow;
        borrow = d < 0;
        s[i] = (uint8_t)(d + (borrow ? 256 : 0));
    }
}

void vp_to_hex(const uint8_t *in, size_t len, char *out) {
    static const char *hx = "0123456789abcdef";
    out[0] = '0';
    out[1] = 'x';
    for (size_t i = 0; i < len; i++) {
        out[2 + 2 * i] = hx[in[i] >> 4];
        out[3 + 2 * i] = hx[in[i] & 15];
    }
    out[2 + 2 * len] = 0;
}
