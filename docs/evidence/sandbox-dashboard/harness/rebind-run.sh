# usage: run.sh <srcdir> <label>   (srcdir contains src/ to run)
S=${OUT:?set OUT to a scratch dir}; SRC=$1; L=$2; D=$S/$L; rm -rf $D; mkdir -p $D
N="node --disable-warning=ExperimentalWarning"; export DB_PATH=$D/jobs.db REPORT_DIR=$D/r
PORT=3981 $N $SRC/src/api.js > $D/api.log 2>&1 & A=$!
sleep 0.7
PORT=3981 DASHBOARD_PORT=3982 $N $SRC/src/dashboard.js > $D/dash.log 2>&1 & B=$!
PORT=3981 DASHBOARD_PORT=3983 ALLOW_REMOTE=1 $N $SRC/src/dashboard.js > $D/dash-remote.log 2>&1 & C=$!
sleep 0.7
c() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
echo "== [$L] curl with untrusted Host"
echo "  API       GET  /metrics  Host: attacker.test:3981          -> $(c -H 'Host: attacker.test:3981' 127.0.0.1:3981/metrics)"
echo "  API       POST /jobs     Host: attacker.test:3981          -> $(c -H 'Host: attacker.test:3981' -H 'content-type: application/json' -d '{"type":"order_report"}' 127.0.0.1:3981/jobs)"
echo "  API       GET  /healthz  Host: 127.0.0.1:3981 (legit)      -> $(c 127.0.0.1:3981/healthz)"
echo "  Dashboard GET  /api/overview Host: attacker.test (default) -> $(c -H 'Host: attacker.test:3982' 127.0.0.1:3982/api/overview)"
echo "  Dashboard GET  /api/overview Host: attacker.test (ALLOW_REMOTE=1, loopback bind) -> $(c -H 'Host: attacker.test:3983' 127.0.0.1:3983/api/overview)"
echo "== [$L] Chromium, simulated rebinding"
node $(dirname $0)/rebind-browser.mjs 3981 /metrics /jobs "$L API"
NO_PNA=1 node $(dirname $0)/rebind-browser.mjs 3981 /metrics /jobs "$L API"
NO_PNA=1 node $(dirname $0)/rebind-browser.mjs 3983 /api/overview /api/jobs "$L dashboard ALLOW_REMOTE=1"
NO_PNA=1 node $(dirname $0)/rebind-browser.mjs 3982 /api/overview /api/jobs "$L dashboard default"
echo "== [$L] jobs in DB: $(curl -s 127.0.0.1:3981/metrics | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).jobs.total)}catch{console.log("?")}})')"
kill $A $B $C
