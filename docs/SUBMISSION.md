# Devpost submission: VoltProof

Copy each section into the matching Devpost field.

---

## Project name

VoltProof

## Tagline (≤ 200 characters)

Hourly solar certificates that prove the energy was real: meter-signed, checked by AI against satellite weather, minted on-chain, and claimable exactly once.

## Track

**Renewable Energy & Energy Trading**: renewable certificate tracking, peer-to-peer energy trading, and tokenized incentives for clean energy.

VoltProof turns every verified hour of rooftop solar into a tradable on-chain certificate. Small
producers can sell it directly to buyers, and a buyer's claim burns it so it can never be counted
twice.

---

## Inspiration

India is putting solar on millions of rooftops, but almost none of that clean energy reaches the
certificate markets that companies use to prove they run on renewables. Registries are built for
power plants, so a household, a school or a farm co-op can't afford to take part. The certificates
that do exist are usually annual, which lets a buyer claim solar power at midnight.

Blockchain looks like the obvious fix until you ask the hard question: *who checks the number
before it goes on-chain?* A ledger proves that someone wrote a value down, not that the value is
true. That's the oracle problem, and it's where we focused.

## What it does

- **Meters sign their own data.** Each meter (an ESP32 with an INA219 sensor, or a simulated
  fleet) generates a private key on the device. It signs every hour's energy reading using EIP-712.
- **An AI verifier checks the claim against the sky.** For that exact location and hour it pulls
  independent irradiance and temperature from Open-Meteo. It computes what a healthy array should
  have produced, using solar geometry, clear-sky physics, a diffuse/direct split and panel
  temperature. It then scores the claim on three signals:
  - physics agreement, with a tolerance that widens under broken cloud where satellite data is least certain;
  - an isolation-forest anomaly model trained on 40,000 honest meter-hours;
  - the meter's own track record.
- **Physically impossible claims are rejected outright:** anything after sunset or above clear-sky output.
- **Persistent cheaters get suspended.** A CUSUM detector accumulates each meter's over-claims. A
  meter that inflates a little every hour is caught within days, even when no single hour looks
  impossible.
- **A smart contract re-checks everything and mints.** `GranularCertificate` verifies both the
  meter's and the verifier's signatures and confirms the meter is registered and active. It
  enforces one certificate per meter-hour and caps energy at nameplate capacity. Only then does it
  mint ERC-1155 tokens, where 1 token = 1 Wh.
- **Peer-to-peer market.** Producers list hours directly. Buyers pay the producer and can buy and
  claim in one transaction. Claiming burns the tokens and records the beneficiary and purpose
  permanently.
- **Tamper-evident audit log.** Every verdict, including every rejection, is hashed into a Merkle
  tree whose root is anchored on-chain.
- **Verify it yourself.** Each certificate page re-runs every check in the browser: the signatures,
  the on-chain hash, the verifier's role and the Merkle proof.
- **Attack lab.** Judges can try eight real attacks against the live system and watch which of the
  seven checks stops each one: inflated reading, sunshine that wasn't there, night generation,
  tampering in transit, forged meter, rogue device and replay.

## How we built it

- **Smart contracts:** Solidity 0.8.24 with OpenZeppelin 5 (ERC-1155, EIP-712, ECDSA,
  AccessControl). Three contracts and 22 Hardhat tests, including every attack path.
- **Verifier:** Python, FastAPI and scikit-learn. The physics is implemented from first principles:
  NOAA solar position, Haurwitz clear-sky, Erbs decomposition, isotropic plane-of-array
  transposition, NOCT cell temperature. We compiled the isolation forest into a single-sample
  scorer that is 25× faster than scikit-learn and matches it to 1e-13.
- **Firmware:** ESP32 C code with a hand-written Keccak-256 and EIP-712 encoder, micro-ecc for
  secp256k1, and low-s normalisation. Compiled for the host and checked bit-for-bit against the
  Python/Solidity reference on 25 random vectors.
- **Frontend:** Next.js 14 with viem, reading the chain directly. Its signature visual is the
  "daylight ledger": every hour drawn against its physical clear-sky ceiling.
- **Deployment:** a local Hardhat chain for the demo, with a Polygon Amoy deployment path.

## Results

We evaluated the verifier on 80 meters it had never seen, each run for 300 daylight hours next to
identical twins that over-report every reading:

- **Honest meters:** 99.9% of hours certified, and none suspended.
- **Inflating by 1.35×:** every cheater suspended within about 29 daylight hours, ending with 0.12×
  the certificates of its honest twin.
- **Inflating by 1.2× or more:** the cheater earns *fewer* certificates than if it told the truth.
- **Night-time claims:** 100% rejected.
- **Full-sun claims under heavy cloud:** 92% rejected.

We're explicit about the limit. Inflation under about 10% hides inside normal satellite-vs-rooftop
disagreement and gains at most about 9%. Physical audits and tamper-resistant key storage bound
that residual.

## Challenges we ran into

- **Not punishing honest producers.** A satellite never sees exactly what one rooftop sees. Our
  first model rejected about 4% of honest readings. Making the tolerance depend on cloud cover, and
  penalising over-reporting harder than under-reporting, brought false rejections to almost zero.
- **Stopping small, steady cheating.** No single-hour test can catch 1.2× inflation on a partly
  cloudy day. Sequential evidence (CUSUM) can, so we changed the question from "is this hour
  wrong?" to "has this meter been wrong for too long?"
- **Stopping a cheater from training its own baseline.** If a meter inflates from day one, its
  history looks normal. We cap any meter's baseline at what a healthy array achieves.
- **Making the firmware match the contract byte for byte.** EIP-712 encoding, address derivation
  and low-s signatures all had to agree exactly across C, Python and Solidity.

## Accomplishments that we're proud of

- A trust chain from sensor to certificate where every link is checkable by anyone.
- A quantitative answer to "can it be gamed?": an economic result, not just an accuracy number.
- An attack lab where judges can try to break it themselves.

## What we learned

The hard part of climate blockchains isn't the chain, it's the data entering it. Physics is an
underrated oracle: the sun's position and the sky's clearness give a verifier something objective
to check every claim against.

## What's next for VoltProof

- Pilot on our campus rooftop with a real meter, then a housing society.
- Require M-of-N independent verifiers (utilities, DISCOMs, auditors) per certificate.
- Peer cross-checks: neighbouring meters see the same clouds, which sharpens verification further.
- Integrate with I-REC and the national registry so certificates can't also be sold off-chain.
- Move keys into ATECC608 secure elements and work with inverter makers to sign at the source.

## Target users, scale and adoption

- **Sellers:** rooftop households, housing societies, schools and campuses, MSMEs and farm co-ops.
- **Buyers:** companies and institutions with hourly clean-energy targets (Scope 2, 24/7 CFE).
- **Auditors and regulators:** use the public ledger.
- **Adoption cost:** a retrofit meter costs under ₹1,500. Many inverters already log hourly output,
  so only signing is new.
- **Running cost:** a certificate mints for a fraction of a cent on Polygon, and the verifier scores
  a reading in under a millisecond.
- **Reporting:** retirement records carry beneficiary and purpose fields for GHG Protocol / ISO
  14064 reporting.

## Built with

solidity, openzeppelin, hardhat, polygon, erc-1155, eip-712, python, fastapi, scikit-learn,
numpy, web3.py, next.js, react, typescript, viem, tailwindcss, esp32, c, micro-ecc, open-meteo

## Links

- Code: `https://github.com/<you>/voltproof`
- Demo video: `<YouTube link>`

---

# Demo video script (about 4 min 15 s)

Record at 1280×800 with the stack running (`./demo.sh`). Speak slowly and keep the cursor still
when you aren't clicking.

**0:00–0:30 · The problem** (Network page, scroll the hero)
> "India is putting solar on millions of rooftops, but almost none of that energy can be sold as
> a clean-energy certificate. Registries are built for power plants, and certificates are annual,
> so companies can claim solar at midnight. Blockchain sounds like the fix, but a ledger only
> proves someone wrote a number down, not that it's true. VoltProof fixes that."

**0:30–1:05 · How it works** (hover the daylight ledger)
> "Each column is one hour across twelve meters in India. The dashed outline is the physical
> limit: clear sky, perfect panel. Yellow is energy certified on-chain. Every meter signs its
> reading with its own key. Our AI verifier checks it against satellite irradiance for that exact
> place and hour, and only then does the contract mint a certificate."

**1:05–2:20 · Attack lab** (the core of the video)
1. Click **Honest reading**: "All seven checks pass and it's minted."
2. Click **Inflated reading**: "Same meter, same key, 2.2× the energy. The signature is valid, so a
   normal blockchain would accept it. Our verifier knows the sky that hour and refuses."
3. Click **Sunshine that wasn't there**: "Now it claims a full midday's output for an hour when
   clouds or a low sun made that impossible. Solar geometry and satellite data say no."
4. Click **Tampered in transit**, then **Replay**: "Changing one number breaks the signature.
   Replaying a certified reading is stopped by the contract itself."
5. Click **Generation at night**, then point at the fraud-evidence bar: "Every signed lie adds
   evidence. After a few, the meter is suspended automatically: even honest readings now wait for
   a physical audit." Click **Mark audit passed and reinstate** to continue.

**2:20–2:50 · Caught over time** (Network page, click **Jodhpur Farm Pump Array**)
> "This meter's firmware was tampered to over-report every hour. The red bars are claims the
> verifier refused; the dashed outline is what the sky physically allowed. The evidence piled up
> and the meter was suspended automatically, with no human in the loop."

**2:50–3:35 · Trade and claim** (Market page)
> "Producers sell hours directly. I'll buy one kilowatt-hour and claim it for our campus. The
> payment goes straight to the producer, and the energy is burned so nobody can claim it again."

Open the certificate, then click **Run checks in my browser**:
> "Anyone can verify this certificate without trusting us. The browser recovers the meter's
> signature, checks the on-chain record, the verifier's role, and the Merkle proof that this
> decision is in the audit log anchored on-chain."

**3:35–4:15 · Proof it works, and impact** (How it's verified page)
> "We tested it on 80 meters it never saw, with twins that lie on every reading. Honest meters get
> 99.9% of hours certified. From 1.2× inflation upward, a cheater earns fewer certificates than if
> it told the truth: cheating doesn't pay. It runs on a ₹1,500 retrofit meter, costs a fraction of
> a cent per certificate on Polygon, and opens clean-energy markets to every rooftop. That's
> VoltProof."
