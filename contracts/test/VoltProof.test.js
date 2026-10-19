const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const READING_TYPES = {
  Reading: [
    { name: "device", type: "address" },
    { name: "hourStart", type: "uint64" },
    { name: "energyWh", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
};
const ATTESTATION_TYPES = {
  Attestation: [
    { name: "readingHash", type: "bytes32" },
    { name: "expectedWh", type: "uint64" },
    { name: "scoreBps", type: "uint16" },
    { name: "modelHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
};
const MODEL_HASH = ethers.id("voltproof-verifier-v1");

describe("VoltProof", function () {
  let admin, producer, buyer, verifier, rogueVerifier, stranger;
  let registry, certs, market, domain, device, device2;

  async function signReading(signer, r) {
    return signer.signTypedData(domain, READING_TYPES, r);
  }
  async function attest(signer, r, { expectedWh, scoreBps = 9200, issuedAt } = {}) {
    const readingHash = await certs.hashReading(r);
    const a = {
      readingHash,
      expectedWh: expectedWh ?? r.energyWh,
      scoreBps,
      modelHash: MODEL_HASH,
      issuedAt: issuedAt ?? (await time.latest()),
    };
    return [a, await signer.signTypedData(domain, ATTESTATION_TYPES, a)];
  }
  async function pastHour(hoursAgo = 2) {
    const now = await time.latest();
    return Math.floor(now / 3600) * 3600 - hoursAgo * 3600;
  }
  async function issueValid(dev = device, hoursAgo = 2, energyWh = 2400, nonce = 1) {
    const r = { device: dev.address, hourStart: await pastHour(hoursAgo), energyWh, nonce };
    const sig = await signReading(dev, r);
    const [a, vsig] = await attest(verifier, r);
    await certs.issue(r, sig, a, vsig);
    return { r, id: await certs.certificateOf(dev.address, r.hourStart) };
  }

  beforeEach(async function () {
    [admin, producer, buyer, verifier, rogueVerifier, stranger] = await ethers.getSigners();
    registry = await ethers.deployContract("DeviceRegistry", [admin.address]);
    certs = await ethers.deployContract("GranularCertificate", [await registry.getAddress(), admin.address, "https://voltproof.app/api/cert/{id}.json"]);
    market = await ethers.deployContract("CertificateMarket", [await certs.getAddress()]);
    await certs.grantRole(await certs.VERIFIER_ROLE(), verifier.address);

    const { chainId } = await ethers.provider.getNetwork();
    domain = { name: "VoltProof", version: "1", chainId, verifyingContract: await certs.getAddress() };

    device = ethers.Wallet.createRandom();
    device2 = ethers.Wallet.createRandom();
    // 3 kW rooftop array in Patiala
    await registry.registerDevice(device.address, producer.address, 30_339_800, 76_386_900, 3000, "Patiala Rooftop #1");
    await registry.registerDevice(device2.address, producer.address, 26_912_400, 75_787_300, 5000, "Jaipur Rooftop #7");
  });

  describe("DeviceRegistry", function () {
    it("stores device identity and enumerates the fleet", async function () {
      const d = await registry.getDevice(device.address);
      expect(d.owner).to.equal(producer.address);
      expect(d.capacityW).to.equal(3000);
      expect(await registry.deviceCount()).to.equal(2);
      expect(await registry.allDevices()).to.deep.equal([device.address, device2.address]);
    });
    it("rejects duplicate registration and non-registrars", async function () {
      await expect(registry.registerDevice(device.address, producer.address, 0, 0, 1000, "dup"))
        .to.be.revertedWithCustomError(registry, "AlreadyRegistered");
      await expect(registry.connect(stranger).registerDevice(stranger.address, stranger.address, 0, 0, 1000, "x"))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });
  });

  describe("Issuance — happy path", function () {
    it("mints Wh to the producer when device + verifier both sign", async function () {
      const r = { device: device.address, hourStart: await pastHour(), energyWh: 2400, nonce: 1 };
      const sig = await signReading(device, r);
      const [a, vsig] = await attest(verifier, r, { expectedWh: 2350 });
      await expect(certs.connect(stranger).issue(r, sig, a, vsig))
        .to.emit(certs, "CertificateIssued")
        .withArgs(1, device.address, producer.address, r.hourStart, 2400, 2350, 9200, verifier.address);

      expect(await certs.balanceOf(producer.address, 1)).to.equal(2400);
      expect(await certs.balanceOf(stranger.address, 1)).to.equal(0); // relayer can't steal
      const c = await certs.getCertificate(1);
      expect(c.device).to.equal(device.address);
      expect(c.readingHash).to.equal(await certs.hashReading(r));
      expect(await certs.totalIssuedWh()).to.equal(2400);
    });

    it("exposes the EIP-712 digest so anyone can independently re-verify", async function () {
      const r = { device: device.address, hourStart: await pastHour(), energyWh: 1000, nonce: 1 };
      const sig = await signReading(device, r);
      const digest = await certs.readingDigest(r);
      expect(ethers.recoverAddress(digest, sig)).to.equal(device.address);
    });
  });

  describe("Issuance — attacks are rejected", function () {
    it("forged reading (signed by a different key)", async function () {
      const r = { device: device.address, hourStart: await pastHour(), energyWh: 2400, nonce: 1 };
      const sig = await signReading(device2, r);
      const [a, vsig] = await attest(verifier, r);
      await expect(certs.issue(r, sig, a, vsig)).to.be.revertedWithCustomError(certs, "BadDeviceSignature");
    });

    it("value tampered after the meter signed it (man-in-the-middle)", async function () {
      const r = { device: device.address, hourStart: await pastHour(), energyWh: 1200, nonce: 1 };
      const sig = await signReading(device, r);
      const tampered = { ...r, energyWh: 2900 };
      const [a, vsig] = await attest(verifier, tampered);
      await expect(certs.issue(tampered, sig, a, vsig)).to.be.revertedWithCustomError(certs, "BadDeviceSignature");
    });

    it("unregistered device", async function () {
      const ghost = ethers.Wallet.createRandom();
      const r = { device: ghost.address, hourStart: await pastHour(), energyWh: 100, nonce: 1 };
      const [a, vsig] = await attest(verifier, r);
      await expect(certs.issue(r, await signReading(ghost, r), a, vsig))
        .to.be.revertedWithCustomError(certs, "DeviceNotActive");
    });

    it("revoked device (e.g. key compromise)", async function () {
      await registry.setActive(device.address, false, "tamper switch triggered");
      const r = { device: device.address, hourStart: await pastHour(), energyWh: 100, nonce: 1 };
      const [a, vsig] = await attest(verifier, r);
      await expect(certs.issue(r, await signReading(device, r), a, vsig))
        .to.be.revertedWithCustomError(certs, "DeviceNotActive");
    });

    it("replay of the same meter-hour (double issuance)", async function () {
      const { r } = await issueValid();
      const r2 = { ...r, nonce: 2 };
      const [a, vsig] = await attest(verifier, r2);
      await expect(certs.issue(r2, await signReading(device, r2), a, vsig))
        .to.be.revertedWithCustomError(certs, "AlreadyCertified");
    });

    it("non-increasing nonce", async function () {
      await issueValid(device, 3, 2000, 5);
      const r = { device: device.address, hourStart: await pastHour(2), energyWh: 2000, nonce: 5 };
      const [a, vsig] = await attest(verifier, r);
      await expect(certs.issue(r, await signReading(device, r), a, vsig))
        .to.be.revertedWithCustomError(certs, "NonceNotIncreasing");
    });

    it("energy above nameplate capacity — on-chain physics cap, even if verifier is fooled", async function () {
      const r = { device: device.address, hourStart: await pastHour(), energyWh: 3301, nonce: 1 }; // 3 kW * 1 h * 110% = 3300
      const [a, vsig] = await attest(verifier, r);
      await expect(certs.issue(r, await signReading(device, r), a, vsig))
        .to.be.revertedWithCustomError(certs, "ExceedsNameplate");
    });

    it("attestation from an unauthorised verifier", async function () {
      const r = { device: device.address, hourStart: await pastHour(), energyWh: 2000, nonce: 1 };
      const [a, vsig] = await attest(rogueVerifier, r);
      await expect(certs.issue(r, await signReading(device, r), a, vsig))
        .to.be.revertedWithCustomError(certs, "BadVerifierSignature");
    });

    it("attestation that belongs to a different reading", async function () {
      const r = { device: device.address, hourStart: await pastHour(), energyWh: 2000, nonce: 1 };
      const other = { ...r, energyWh: 500 };
      const [a, vsig] = await attest(verifier, other);
      await expect(certs.issue(r, await signReading(device, r), a, vsig))
        .to.be.revertedWithCustomError(certs, "AttestationMismatch");
    });

    it("verifier confidence below threshold", async function () {
      const r = { device: device.address, hourStart: await pastHour(), energyWh: 2000, nonce: 1 };
      const [a, vsig] = await attest(verifier, r, { scoreBps: 4100 });
      await expect(certs.issue(r, await signReading(device, r), a, vsig))
        .to.be.revertedWithCustomError(certs, "ScoreTooLow");
    });

    it("stale attestation", async function () {
      const r = { device: device.address, hourStart: await pastHour(), energyWh: 2000, nonce: 1 };
      const [a, vsig] = await attest(verifier, r, { issuedAt: (await time.latest()) - 2 * 86400 });
      await expect(certs.issue(r, await signReading(device, r), a, vsig))
        .to.be.revertedWithCustomError(certs, "AttestationStale");
    });

    it("hour not finished yet / not aligned / too old", async function () {
      const now = await time.latest();
      const current = Math.floor(now / 3600) * 3600;
      for (const [hourStart, err] of [
        [current, "HourNotFinished"],
        [current - 3600 + 60, "HourNotAligned"],
        [current - 31 * 86400, "ReadingTooOld"],
      ]) {
        const r = { device: device.address, hourStart, energyWh: 100, nonce: 1 };
        const [a, vsig] = await attest(verifier, r);
        await expect(certs.issue(r, await signReading(device, r), a, vsig)).to.be.revertedWithCustomError(certs, err);
      }
    });
  });

  describe("Retirement — no double counting", function () {
    it("burns Wh permanently and records the claim", async function () {
      const { id } = await issueValid();
      await expect(certs.connect(producer).retire(id, 1000, ethers.ZeroAddress, "Thapar Institute", "Scope 2 — Oct 2026"))
        .to.emit(certs, "CertificateRetired")
        .withArgs(0, id, producer.address, producer.address, 1000, "Thapar Institute", "Scope 2 — Oct 2026");

      expect(await certs.balanceOf(producer.address, id)).to.equal(1400);
      expect(await certs.retiredWhOf(id)).to.equal(1000);
      expect(await certs.totalRetiredWh()).to.equal(1000);
      const ret = await certs.getRetirement(0);
      expect(ret.beneficiary).to.equal("Thapar Institute");
    });

    it("cannot retire more than held — the same Wh can never be claimed twice", async function () {
      const { id } = await issueValid();
      await certs.connect(producer).retire(id, 2400, ethers.ZeroAddress, "A", "p");
      await expect(certs.connect(producer).retire(id, 1, ethers.ZeroAddress, "B", "p"))
        .to.be.revertedWithCustomError(certs, "ERC1155InsufficientBalance");
      await expect(certs.connect(producer).safeTransferFrom(producer.address, buyer.address, id, 1, "0x"))
        .to.be.revertedWithCustomError(certs, "ERC1155InsufficientBalance");
    });
  });

  describe("CertificateMarket — P2P trading", function () {
    const PRICE = ethers.parseUnits("1", "gwei"); // per Wh

    beforeEach(async function () {
      await issueValid();
      await certs.connect(producer).setApprovalForAll(await market.getAddress(), true);
      await market.connect(producer).list(1, 2000, PRICE);
    });

    it("escrows listed Wh and pays the producer directly", async function () {
      expect(await certs.balanceOf(await market.getAddress(), 1)).to.equal(2000);
      const before = await ethers.provider.getBalance(producer.address);
      await market.connect(buyer).buy(0, 500, false, "", "", { value: 500n * PRICE });
      expect(await certs.balanceOf(buyer.address, 1)).to.equal(500);
      expect(await ethers.provider.getBalance(producer.address)).to.equal(before + 500n * PRICE);
      expect((await market.getListing(0)).remainingWh).to.equal(1500);
    });

    it("buy-and-retire atomically credits the buyer as claimant", async function () {
      await expect(market.connect(buyer).buy(0, 800, true, "Acme Textiles", "24/7 CFE matching", { value: 800n * PRICE }))
        .to.emit(certs, "CertificateRetired")
        .withArgs(0, 1, buyer.address, await market.getAddress(), 800, "Acme Textiles", "24/7 CFE matching");
      expect(await certs.retiredWhBy(buyer.address)).to.equal(800);
      expect(await certs.balanceOf(buyer.address, 1)).to.equal(0);
    });

    it("rejects wrong payment and oversell; seller can cancel", async function () {
      await expect(market.connect(buyer).buy(0, 10, false, "", "", { value: 1 })).to.be.revertedWithCustomError(market, "WrongPayment");
      await expect(market.connect(buyer).buy(0, 2001, false, "", "", { value: 2001n * PRICE })).to.be.revertedWithCustomError(market, "InsufficientSupply");
      await expect(market.connect(buyer).cancel(0)).to.be.revertedWithCustomError(market, "NotSeller");
      await market.connect(producer).cancel(0);
      expect(await certs.balanceOf(producer.address, 1)).to.equal(2400);
    });
  });

  describe("Audit log", function () {
    it("only verifiers can anchor verdict batches (incl. rejections)", async function () {
      const root = ethers.id("merkle-root");
      await expect(certs.connect(verifier).anchorAuditBatch(root, 42, 7, 1, 2))
        .to.emit(certs, "AuditBatchAnchored").withArgs(0, root, 42, 7, 1, 2);
      await expect(certs.connect(stranger).anchorAuditBatch(root, 1, 1, 1, 2))
        .to.be.revertedWithCustomError(certs, "AccessControlUnauthorizedAccount");
      expect((await certs.getAuditBatch(0)).rejected).to.equal(7);
    });
  });
});
