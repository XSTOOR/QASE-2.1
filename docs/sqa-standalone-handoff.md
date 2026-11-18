# Standalone SQA development and qualification

New SQA runs require `sqa-single-reasoner-v1`. The launcher shows unavailable
configuration and the API returns HTTP 409 before creating a run. Historical
runs retain their saved evidence and recorded engine. Runs without a recorded
mode strategy use their original legacy adapter. Standalone uses CleanSlate
SDK 0.1.0 and Opus 4.7. The dedicated reasoner key is independent of JEV.
No database migration is required.

## Local setup

```sh
npm ci
npx playwright install chromium
node scripts/probe-sqa-research-workflow.mjs --fixture
npm run start:local
```

The fixture uses a private scripted model stream, synthetic source metadata and
real local Chromium. It exercises discovery, applicability, planning, evidence,
checkpoint recovery and draft exports. Leave `QASE_SQA_STANDALONE_ENABLED=false`
while live qualification is pending. The fixture writes its checkpoints and
drafts under `.qase/validation/sqa-development-fixture/`.

## Dedicated development search provider

Choose an organization-controlled HTTPS hostname with a valid certificate and
public DNS for an approved development search deployment. Restrict ingress at
the TLS proxy to the QASE host's egress addresses. The QASE transport rejects
private addresses and verifies the public hostname, so a plaintext loopback
endpoint, private address or self-signed certificate cannot serve as its
configured search provider.

On the search host, use the official container setup and pin an approved
SearXNG image by digest. Set `SEARXNG_SECRET` in a private environment file and
configure `SEARXNG_BASE_URL` with the actual HTTPS origin. Enable JSON in
`settings.yml`. Bind the container port to loopback and expose the proxy only.
See [SearXNG container installation](https://docs.searxng.org/admin/installation-docker.html)
and [search format configuration](https://docs.searxng.org/admin/settings/settings_search.html).

```yaml
use_default_settings: true
server:
  public_instance: false
search:
  formats:
    - json
```

```sh
docker run --rm --name qase-dev-searxng --env-file ./searxng.private.env \
  --publish 127.0.0.1:8888:8080 \
  --volume "${PWD}/searxng-config:/etc/searxng" \
  "${APPROVED_SEARXNG_IMAGE:?Set the approved image reference including digest}"
```

For Nginx, add the rate-limit zone in its HTTP context and place this location
inside a TLS-enabled virtual host. Substitute the approved QASE egress address
for the documentation address and validate the proxy configuration before
loading it. Configure a real certificate, trusted proxy boundaries and an
operational timeout for the search service.

```nginx
limit_req_zone $binary_remote_addr zone=qase_search:1m rate=2r/s;

# Within the TLS-enabled server block
location = /search {
    allow 192.0.2.42;
    deny all;
    limit_except GET { deny all; }
    limit_req zone=qase_search burst=5 nodelay;
    limit_req_status 429;
    proxy_connect_timeout 3s;
    proxy_read_timeout 10s;
    proxy_set_header Authorization "";
    proxy_set_header Cookie "";
    proxy_pass http://127.0.0.1:8888;
}
```

With approval, set `QASE_SQA_SEARCH_URL` to the real HTTPS `/search` URL and
configure `QASE_SQA_REASONER_API_KEY` in the server environment. These diagnostics
verify the provider response and bounded SDK execution.

```sh
QASE_LIVE_SYSTEM_QUALIFICATION=true node scripts/probe-sqa-standalone.mjs
QASE_LIVE_SYSTEM_QUALIFICATION=true node scripts/probe-sqa-research-workflow.mjs
```

The direct-source workflow uses a supplied W3C publication. These diagnostics
do not establish live end-to-end publication, documentary review, cross-sector
coverage, or process restart recovery. The standalone activation gate requires
a current receipt from full qualification of the exact SDK/model/search
configuration. Keep activation disabled until those capabilities pass.
