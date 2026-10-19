#!/usr/bin/env bash
# One command to run the whole VoltProof stack locally:
#   local chain → contracts + fleet registration → AI verifier → 72 h of meter data
#   → producers list certificates → a few buyer claims → web app on http://localhost:3000
#
#   ./demo.sh            fresh start (wipes local chain state)
#   ./demo.sh --hours 96 more history
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(pwd)
HOURS=72
[[ "${1:-}" == "--hours" ]] && HOURS="$2"
LOGS="$ROOT/.logs"; mkdir -p "$LOGS"

say() { printf "\n\033[1m▸ %s\033[0m\n" "$*"; }
wait_for() { for _ in $(seq 1 90); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 1; done; echo "timed out waiting for $1"; exit 1; }

cleanup() { say "Stopping"; kill $(jobs -p) 2>/dev/null || true; }
trap cleanup EXIT INT TERM

say "Installing dependencies (first run only)"
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
pip install -q -r requirements.txt
( cd contracts && [ -d node_modules ] || npm install --legacy-peer-deps --silent )
( cd web && [ -d node_modules ] || npm install --silent )
[ -f web/.env.local ] || cp web/.env.example web/.env.local

say "Starting local chain"
pkill -f "[n]ext dev" 2>/dev/null || true
pkill -f "[n]ext-server" 2>/dev/null || true
pkill -f "[u]vicorn verifier.app" 2>/dev/null || true
pkill -f "[h]ardhat node" 2>/dev/null || true
( cd contracts && npx hardhat node > "$LOGS/chain.log" 2>&1 ) &
for _ in $(seq 1 60); do
  curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545 >/dev/null 2>&1 && break
  sleep 1
done

say "Creating meter fleet and deploying contracts"
rm -f simulator/state.json verifier/verdicts-31337.sqlite
python -m simulator init --force
( cd contracts && npx hardhat run scripts/deploy.js --network localhost )

say "Starting two independent AI verifiers (2-of-2 must agree before anything is minted)"
pkill -f "[u]vicorn verifier.app" 2>/dev/null || true
rm -f verifier/verdicts-peer-31337.sqlite
# Verifier B: Hardhat account #2, its own database and fraud history; only co-signs.
VERIFIER_MODE=peer VERIFIER_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a \
  DB_PATH=verifier/verdicts-peer-31337.sqlite uvicorn verifier.app:app --port 8001 > "$LOGS/verifier-b.log" 2>&1 &
wait_for http://127.0.0.1:8001/v1/health
# Verifier A: Hardhat account #1; collects co-signatures and mints.
PEERS=http://127.0.0.1:8001 uvicorn verifier.app:app --port 8000 > "$LOGS/verifier.log" 2>&1 &
wait_for http://127.0.0.1:8000/v1/health
curl -s http://127.0.0.1:8000/v1/health | python -c "import sys,json; h=json.load(sys.stdin); print('weather source:', h['weather'])"

say "Meters submitting ${HOURS} h of signed readings"
python -m simulator backfill --hours "$HOURS"

say "Producers listing certificates on the market"
python -m simulator market

say "A few buyers claiming energy"
python -m simulator buy-demo || true

[ -f eval/results.json ] || { say "Evaluating the model (one-off, ~2 min)"; python -m verifier.evaluate; }

say "Starting web app"
rm -rf web/.next
( cd web && npm run dev > "$LOGS/web.log" 2>&1 ) &
wait_for http://127.0.0.1:3000

cat <<EOF

  VoltProof is running
  ─────────────────────────────────────────────
  Web app      http://localhost:3000
  Attack lab   http://localhost:3000/lab
  Verifier API http://127.0.0.1:8000/docs
  Local chain  http://127.0.0.1:8545  (chain id 31337)

  Logs in .logs/ · Ctrl-C stops everything.
EOF
wait
