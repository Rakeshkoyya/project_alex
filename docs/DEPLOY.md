# Deploying Project Alex on Dokploy

Alex ships as **one container**: the Node server serves both the API and the built web UI on port `8787`. All student data (accounts, courses, Pi session files) lives in `/data`, so that path must be a persistent volume.

## 1. Before you start

You need:

- A Dokploy server with a domain pointing at it (an `A` record, e.g. `alex.example.com` → server IP).
- An **OpenRouter API key** from https://openrouter.ai/keys, with some credit on the account.
- This repository in GitHub, connected to Dokploy (Settings → Git → GitHub).
- A long random secret for login cookies. Generate one with `openssl rand -hex 32`.

## 2. Create the application

1. In Dokploy, open (or create) a **Project**, then **Create Service → Application**. Name it `alex`.
2. Under **General → Provider**, choose **GitHub**, select the repository, pick the branch you merged into (e.g. `main`), and save.
3. Under **Build Type**, choose **Dockerfile**:
   - Dockerfile path: `Dockerfile`
   - Docker context path: `.`
   - Save.

## 3. Environment variables

Open the **Environment** tab and paste the following, filling in your values:

```env
OPENROUTER_API_KEY=sk-or-v1-your-key
ALEX_MODEL=deepseek/deepseek-v4-flash
ALEX_SECRET=paste-the-output-of-openssl-rand-hex-32
ALEX_ALLOW_SIGNUP=true
```

Optional:

```env
TAVILY_API_KEY=...                      # better web search for the Librarian (falls back to Wikipedia)
ALEX_MODEL_ADVISOR=deepseek/deepseek-v4-pro   # a stronger model for just one role
ALEX_THINKING=off                       # off | low | medium | high reasoning (off is fastest)
ALEX_MAX_OUTPUT_TOKENS=16000
```

Save. Never commit these values to git; `.env` is git-ignored.

## 4. Persistent storage

Open **Advanced → Volumes / Mounts → Add Volume**:

- Type: **Volume** (a named Docker volume)
- Volume name: `alex-data`
- Mount path: `/data`

Without this, every redeploy wipes all accounts and courses.

## 5. Domain and HTTPS

Open **Domains → Add Domain**:

- Host: `alex.example.com`
- Path: `/`
- Container port: **`8787`**
- HTTPS: on, with certificate provider **Let's Encrypt**

## 6. Deploy

Click **Deploy** and watch the build log. The build runs `npm ci`, compiles the vendored Pi agent, builds the web UI and prunes dev dependencies. The first build takes a few minutes.

The app is up when the log shows:

```
Project Alex on http://localhost:8787 — openrouter · deepseek/deepseek-v4-flash · Pi AgentHarness · data /data
```

The container has a built-in health check on `/api/health`.

## 7. First login

1. Open `https://alex.example.com`, click **Create an account**, and register yourself.
2. Optional: to stop strangers registering and spending your OpenRouter credit, set `ALEX_ALLOW_SIGNUP=false` in Environment and click **Redeploy**. Existing accounts keep working, and new ones can't be created.
3. The badge top-right should read **Live · deepseek/deepseek-v4-flash**. If it says **Demo mode**, the server didn't see `OPENROUTER_API_KEY`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Badge says *Demo mode* | `OPENROUTER_API_KEY` is missing or misspelled in Environment. Redeploy after fixing it. |
| Build fails pulling `node:22-bookworm-slim` with a 429 | Docker Hub rate limit on your server. Run `docker login` on the server, or add the build arg `NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim`. |
| Container exits with `Unknown openrouter model` | `ALEX_MODEL` isn't in Pi's OpenRouter catalogue. Use an id like `deepseek/deepseek-v4-flash` exactly. |
| Faculty step shows an error such as `401` or `402` | Invalid key or no credit on OpenRouter. Fix it, then press **Resume** on the course. |
| Everyone got logged out after a redeploy | `ALEX_SECRET` changed or isn't set. Keep it fixed. |
| Courses disappeared after a redeploy | The `/data` volume isn't mounted (step 4). |
| Long replies cut off mid-stream | Check that no extra proxy buffers responses. Alex sends keep-alive pings every 15 s and `X-Accel-Buffering: no`. |

## Alternative: Docker Compose

The repository also has `docker-compose.yml`. In Dokploy, choose **Create Service → Compose**, point it at the repo, set the same environment variables, and add the domain on service `alex`, port `8787`. The compose file already declares the `alex-data` volume.

Locally: `cp .env.example .env`, fill it in, uncomment `ports` in `docker-compose.yml`, then run `docker compose up --build` and open http://localhost:8787.

## Backups

Everything is in the `alex-data` volume. On the server:

```bash
docker run --rm -v alex-data:/data -v "$PWD":/backup busybox tar czf /backup/alex-data-$(date +%F).tgz -C /data .
```

Dokploy may prefix the volume name with the project name; check with `docker volume ls`.
