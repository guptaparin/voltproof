// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {DeviceRegistry} from "./DeviceRegistry.sol";

/// @title GranularCertificate (VoltProof)
/// @notice Hourly Energy Attribute Certificates. One token id = one meter-hour of
///         verified renewable generation; balance unit = 1 Wh.
///
///         A certificate is issued only when BOTH hold:
///           1. the meter itself signed the reading (EIP-712, key registered on-chain), and
///           2. an authorised AI verifier signed an attestation that the reading is
///              physically plausible against independent weather data.
///         Each meter-hour can be issued exactly once, and every Wh can be retired
///         (burned) exactly once, so the same clean energy can never be claimed twice.
contract GranularCertificate is ERC1155, AccessControl, EIP712 {
    using ECDSA for bytes32;

    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");

    bytes32 public constant READING_TYPEHASH =
        keccak256("Reading(address device,uint64 hourStart,uint64 energyWh,uint64 nonce)");
    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(bytes32 readingHash,uint64 expectedWh,uint16 scoreBps,bytes32 modelHash,uint64 issuedAt)");

    uint256 public constant HOUR = 3600;
    uint256 public constant MAX_READING_AGE = 30 days;
    uint256 public constant MAX_ATTESTATION_AGE = 1 days;
    uint16 public constant MIN_SCORE_BPS = 7000;            // verifier confidence floor (70%)
    uint256 public constant NAMEPLATE_TOLERANCE_BPS = 11000; // 110% of nameplate: physics hard cap

    struct Reading {
        address device;
        uint64 hourStart;   // unix seconds, aligned to the hour (UTC)
        uint64 energyWh;    // energy generated during [hourStart, hourStart+1h)
        uint64 nonce;       // strictly increasing per device
    }

    struct Attestation {
        bytes32 readingHash; // EIP-712 struct hash of the Reading
        uint64 expectedWh;   // verifier's physics-model estimate
        uint16 scoreBps;     // plausibility score, 0..10000
        bytes32 modelHash;   // hash of verifier model version / parameters
        uint64 issuedAt;
    }

    struct Certificate {
        address device;
        address producer;
        address verifier;
        uint64 hourStart;
        uint64 energyWh;
        uint64 expectedWh;
        uint16 scoreBps;
        uint64 issuedAt;
        bytes32 readingHash;
        bytes32 modelHash;
        uint8 verifierCount;  // how many independent verifiers attested
    }

    struct Retirement {
        uint256 certificateId;
        uint256 amountWh;
        address retiredBy;    // caller (holder or marketplace escrow)
        address onBehalfOf;   // the party claiming the clean energy
        uint64 timestamp;
        string beneficiary;   // e.g. "Thapar Institute — Scope 2, Oct 2026"
        string purpose;
    }

    struct AuditBatch {
        bytes32 merkleRoot;   // root over ALL verdicts (accepted + rejected) in the window
        uint32 accepted;
        uint32 rejected;
        uint64 fromTs;
        uint64 toTs;
        address verifier;
    }

    DeviceRegistry public immutable registry;

    uint256 public nextId = 1;
    uint8 public attestationThreshold = 1; // M in M-of-N; raise as independent verifiers join
    uint256 public totalIssuedWh;
    uint256 public totalRetiredWh;

    mapping(uint256 => Certificate) private _certs;
    mapping(uint256 => uint256) public retiredWhOf;          // per certificate
    mapping(address => mapping(uint64 => uint256)) public certificateOf; // device => hourStart => id
    mapping(address => uint64) public lastNonce;
    mapping(address => uint256) public retiredWhBy;           // per onBehalfOf

    Retirement[] private _retirements;
    AuditBatch[] private _auditBatches;

    event CertificateIssued(
        uint256 indexed id,
        address indexed device,
        address indexed producer,
        uint64 hourStart,
        uint64 energyWh,
        uint64 expectedWh,
        uint16 scoreBps,
        address verifier
    );
    event CertificateRetired(
        uint256 indexed retirementId,
        uint256 indexed certificateId,
        address indexed onBehalfOf,
        address retiredBy,
        uint256 amountWh,
        string beneficiary,
        string purpose
    );
    event AttestationThresholdChanged(uint8 threshold);
    event AuditBatchAnchored(uint256 indexed batchId, bytes32 merkleRoot, uint32 accepted, uint32 rejected, uint64 fromTs, uint64 toTs);

    error DeviceNotActive(address device);
    error BadDeviceSignature();
    error BadVerifierSignature(address recovered);
    error HourNotAligned();
    error HourNotFinished();
    error ReadingTooOld();
    error AlreadyCertified(address device, uint64 hourStart, uint256 existingId);
    error NonceNotIncreasing(uint64 last, uint64 given);
    error ExceedsNameplate(uint64 energyWh, uint256 maxWh);
    error AttestationMismatch();
    error AttestationStale();
    error ScoreTooLow(uint16 scoreBps);
    error ZeroEnergy();
    error ZeroAmount();
    error NotEnoughAttestations(uint256 given, uint8 required);
    error DuplicateVerifier(address verifier);
    error InvalidThreshold();

    constructor(DeviceRegistry registry_, address admin, string memory uri_)
        ERC1155(uri_)
        EIP712("VoltProof", "1")
    {
        registry = registry_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ───────────────────────────── hashing helpers ─────────────────────────────

    function hashReading(Reading calldata r) public pure returns (bytes32) {
        return keccak256(abi.encode(READING_TYPEHASH, r.device, r.hourStart, r.energyWh, r.nonce));
    }

    function hashAttestation(Attestation calldata a) public pure returns (bytes32) {
        return keccak256(abi.encode(ATTESTATION_TYPEHASH, a.readingHash, a.expectedWh, a.scoreBps, a.modelHash, a.issuedAt));
    }

    /// @notice Full EIP-712 digest a meter signs. Exposed so anyone can re-verify.
    function readingDigest(Reading calldata r) external view returns (bytes32) {
        return _hashTypedDataV4(hashReading(r));
    }

    function attestationDigest(Attestation calldata a) external view returns (bytes32) {
        return _hashTypedDataV4(hashAttestation(a));
    }

    // ─────────────────────────────── issuance ────────────────────────────────

    /// @notice Single-verifier issuance (valid while attestationThreshold == 1).
    ///         Anyone (typically the verifier's relayer) may submit; certificates always
    ///         go to the device owner, so the submitter cannot steal them.
    function issue(
        Reading calldata r,
        bytes calldata deviceSig,
        Attestation calldata a,
        bytes calldata verifierSig
    ) external returns (uint256 id) {
        Attestation[] memory atts = new Attestation[](1);
        bytes[] memory sigs = new bytes[](1);
        atts[0] = a;
        sigs[0] = verifierSig;
        return _issue(r, deviceSig, atts, sigs);
    }

    /// @notice M-of-N issuance: at least `attestationThreshold` *distinct* authorised
    ///         verifiers must independently attest to the same reading. Signatures must be
    ///         ordered by ascending verifier address (proves distinctness cheaply).
    function issueMulti(
        Reading calldata r,
        bytes calldata deviceSig,
        Attestation[] calldata atts,
        bytes[] calldata verifierSigs
    ) external returns (uint256 id) {
        return _issue(r, deviceSig, atts, verifierSigs);
    }

    function setAttestationThreshold(uint8 threshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (threshold == 0) revert InvalidThreshold();
        attestationThreshold = threshold;
        emit AttestationThresholdChanged(threshold);
    }

    function _issue(
        Reading calldata r,
        bytes calldata deviceSig,
        Attestation[] memory atts,
        bytes[] memory sigs
    ) internal returns (uint256 id) {
        DeviceRegistry.Device memory d = registry.getDevice(r.device);
        if (!d.active) revert DeviceNotActive(r.device);
        if (r.energyWh == 0) revert ZeroEnergy();

        // time sanity
        if (r.hourStart % HOUR != 0) revert HourNotAligned();
        if (uint256(r.hourStart) + HOUR > block.timestamp) revert HourNotFinished();
        if (block.timestamp - r.hourStart > MAX_READING_AGE) revert ReadingTooOld();

        // replay / double-issuance protection
        uint256 existing = certificateOf[r.device][r.hourStart];
        if (existing != 0) revert AlreadyCertified(r.device, r.hourStart, existing);
        if (r.nonce <= lastNonce[r.device]) revert NonceNotIncreasing(lastNonce[r.device], r.nonce);

        // physics hard cap enforced on-chain, independent of any verifier
        uint256 maxWh = (uint256(d.capacityW) * NAMEPLATE_TOLERANCE_BPS) / 10_000;
        if (r.energyWh > maxWh) revert ExceedsNameplate(r.energyWh, maxWh);

        // 1) the meter signed exactly this reading
        bytes32 rHash = hashReading(r);
        if (_hashTypedDataV4(rHash).recover(deviceSig) != r.device) revert BadDeviceSignature();

        // 2) enough distinct authorised verifiers attested to *this* reading
        if (atts.length != sigs.length || atts.length < attestationThreshold) {
            revert NotEnoughAttestations(atts.length, attestationThreshold);
        }
        address firstVerifier;
        address prev;
        uint16 minScore = 10_000;
        for (uint256 i = 0; i < atts.length; i++) {
            Attestation memory a = atts[i];
            if (a.readingHash != rHash) revert AttestationMismatch();
            if (a.issuedAt > block.timestamp + 300 || block.timestamp - a.issuedAt > MAX_ATTESTATION_AGE) revert AttestationStale();
            if (a.scoreBps < MIN_SCORE_BPS || a.scoreBps > 10_000) revert ScoreTooLow(a.scoreBps);
            address v = _hashTypedDataV4(_hashAttestationMem(a)).recover(sigs[i]);
            if (!hasRole(VERIFIER_ROLE, v)) revert BadVerifierSignature(v);
            if (v <= prev) revert DuplicateVerifier(v);
            prev = v;
            if (i == 0) firstVerifier = v;
            if (a.scoreBps < minScore) minScore = a.scoreBps;
        }

        id = nextId++;
        lastNonce[r.device] = r.nonce;
        certificateOf[r.device][r.hourStart] = id;
        _certs[id] = Certificate({
            device: r.device,
            producer: d.owner,
            verifier: firstVerifier,
            hourStart: r.hourStart,
            energyWh: r.energyWh,
            expectedWh: atts[0].expectedWh,
            scoreBps: minScore,
            issuedAt: uint64(block.timestamp),
            readingHash: rHash,
            modelHash: atts[0].modelHash,
            verifierCount: uint8(atts.length)
        });
        totalIssuedWh += r.energyWh;

        _mint(d.owner, id, r.energyWh, "");
        emit CertificateIssued(id, r.device, d.owner, r.hourStart, r.energyWh, atts[0].expectedWh, minScore, firstVerifier);
    }

    function _hashAttestationMem(Attestation memory a) internal pure returns (bytes32) {
        return keccak256(abi.encode(ATTESTATION_TYPEHASH, a.readingHash, a.expectedWh, a.scoreBps, a.modelHash, a.issuedAt));
    }

    // ─────────────────────────────── retirement ──────────────────────────────

    /// @notice Permanently claim (burn) clean energy. Burned Wh can never be
    ///         transferred, resold or claimed again — this is what prevents double counting.
    function retire(
        uint256 id,
        uint256 amountWh,
        address onBehalfOf,
        string calldata beneficiary,
        string calldata purpose
    ) external returns (uint256 retirementId) {
        if (amountWh == 0) revert ZeroAmount();
        _burn(msg.sender, id, amountWh); // reverts if balance is insufficient
        address claimant = onBehalfOf == address(0) ? msg.sender : onBehalfOf;

        retiredWhOf[id] += amountWh;
        retiredWhBy[claimant] += amountWh;
        totalRetiredWh += amountWh;

        retirementId = _retirements.length;
        _retirements.push(Retirement(id, amountWh, msg.sender, claimant, uint64(block.timestamp), beneficiary, purpose));
        emit CertificateRetired(retirementId, id, claimant, msg.sender, amountWh, beneficiary, purpose);
    }

    // ─────────────────────────────── audit log ───────────────────────────────

    /// @notice Verifiers periodically anchor a Merkle root over every verdict they made,
    ///         including rejections, so their off-chain decisions are tamper-evident.
    function anchorAuditBatch(bytes32 root, uint32 accepted, uint32 rejected, uint64 fromTs, uint64 toTs)
        external
        onlyRole(VERIFIER_ROLE)
        returns (uint256 batchId)
    {
        batchId = _auditBatches.length;
        _auditBatches.push(AuditBatch(root, accepted, rejected, fromTs, toTs, msg.sender));
        emit AuditBatchAnchored(batchId, root, accepted, rejected, fromTs, toTs);
    }

    // ───────────────────────────────── views ─────────────────────────────────

    function getCertificate(uint256 id) external view returns (Certificate memory) {
        return _certs[id];
    }

    function retirementCount() external view returns (uint256) {
        return _retirements.length;
    }

    function getRetirement(uint256 i) external view returns (Retirement memory) {
        return _retirements[i];
    }

    function auditBatchCount() external view returns (uint256) {
        return _auditBatches.length;
    }

    function getAuditBatch(uint256 i) external view returns (AuditBatch memory) {
        return _auditBatches[i];
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
