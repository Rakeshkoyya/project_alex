# Deploying Project Alex on Dokploy

Alex ships as **one container**. The Node server serves the API and the built web UI together on port `8787`. All student data lives in `/data`, so that path must be a persistent volume.

By default the site is **open to everyone with no login**. Each visitor's browser gets its own private set of courses through an anonymous cookie. There's nothing to configure for this, and no secret to generate.

## 1. Get your keys

| Key | Where | Needed? |
|---|---|---|
| `OPENROUTER_API_KEY` | https://openrouter.ai/keys (add a few dollars of credit) | **Yes.** Every agent runs on it. |
| `BRAVE_API_KEY` | https://api-dashboard.search.brave.com/register → create a **Free AI** subscription → **API Keys** → create key (a card is needed to sign up; the free tier isn't charged) | **Recommended.** Web search engine #1. |
| `TAVILY_API_KEY` | https://app.tavily.com → sign up → copy the API key (`tvly-…`) from the dashboard (free tier: 1,000 credits/month) | **Recommended.** Web search engine #2. |

With both keys set, every search runs on **Brave, Tavily and Wikipedia in parallel** (Wikipedia needs no key). Results are merged and de-duplicated, and each is tagged with the engines that found it, so pages both engines agree on rank first. The Librarian's `verify_fact` tool cross-checks every fact it saves against several independent sources. If one engine fails (quota, outage, bad key), the other carries on automatically. If both keyed engines fail, Wikipedia still answers.

## 2. Create the application

1. In Dokploy, open (or create) a **Project**, then **Create Service → Application**. Name it `alex`.
2. **General → Provider**: GitHub, this repository, and the branch you merged into (e.g. `main`). Save.
3. **Build Type**: **Dockerfile**, with Dockerfile path `Dockerfile` and context `.`. Save.

## 3. Environment variables

In the **Environment** tab, paste:

```env
OPENROUTER_API_KEY=sk-or-v1-your-key
ALEX_MODEL=deepseek/deepseek-v4-flash
BRAVE_API_KEY=your-brave-key
TAVILY_API_KEY=tvly-your-key
```

That's all that's required. Optional extras:

```env
ALEX_MODEL_ADVISOR=deepseek/deepseek-v4-pro   # a stronger model for one role
ALEX_THINKING=off                             # off | low | medium | high (off is fastest and cheapest)
ALEX_MAX_OUTPUT_TOKENS=16000
ALEX_TAVILY_DEPTH=advanced                    # deeper Tavily results (2 credits per search instead of 1)
ALEX_RESEARCH_MAX_PAGES=14                    # web pages read into each new course's bag
ALEX_RESEARCH_PER_TOPIC=2                     # web pages per research topic
ALEX_REQUIRE_LOGIN=true                       # switch to username/password accounts instead of open access
```

Save.

## 4. Persistent storage

Go to **Advanced → Volumes / Mounts → Add Volume** and set:

- **Type:** Volume
- **Name:** `alex-data`
- **Mount path:** `/data`

Without this, every redeploy wipes all courses.

## 5. Domain and HTTPS

1. Point your domain at the server: a DNS `A` record, e.g. `alex.yourdomain.com` → your server's IP.
2. In Dokploy, open **Domains → Add Domain** and set:
   - **Host:** `alex.yourdomain.com`
   - **Path:** `/`
   - **Container Port:** `8787`
   - **HTTPS:** on, with certificate **Let's Encrypt**

## 6. Deploy and check

Click **Deploy**. The first build takes a few minutes: it compiles the vendored Pi agent and builds the web UI. When it's running, the log shows:

```
Project Alex on http://localhost:8787 — openrouter · deepseek/deepseek-v4-flash · search: brave+tavily+wikipedia · open access · data /data
```

Open `https://alex.yourdomain.com`. You land straight on "What do you want to learn?".

- The badge top-right should read **Live · deepseek/deepseek-v4-flash**.
- `https://alex.yourdomain.com/api/status` shows `"search": "brave+tavily+wikipedia"` when both search keys are picked up (Wikipedia needs no key).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Badge says **Demo mode** | `OPENROUTER_API_KEY` is missing or misspelled. Fix it and redeploy. |
| `/api/status` shows `"search": "brave+wikipedia"` or `"tavily+wikipedia"` | The other key isn't set. Search still works, with one keyed engine plus Wikipedia. |
| `/api/status` shows `"search": "wikipedia"` | Neither search key is set. Only Wikipedia is searched. |
| The Librarian's activity shows `brave failed (…)` or `tavily failed (…)` | That engine errored (quota, outage or bad key) and the other one was used. Check that engine's dashboard for quota or key problems. |
| An agent step fails with `401` or `402` | Bad OpenRouter key or no credit. Fix it, then click **Resume** on the course. |
| Build fails pulling `node:22-bookworm-slim` (HTTP 429) | Docker Hub rate limit. Run `docker login` on the server, or add build arg `NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim`. |
| Container exits: `Unknown openrouter model` | Check `ALEX_MODEL` spelling, e.g. `deepseek/deepseek-v4-flash`. |
| Courses vanish after a redeploy | The `/data` volume isn't mounted (step 4). |
| A student lost their courses | In open mode, courses belong to the browser. Clearing cookies or using another device starts fresh. Use `ALEX_REQUIRE_LOGIN=true` if students need accounts. |

## About open access and cost

In open mode anyone who finds the URL can use it, and every agent call is billed to your OpenRouter key. DeepSeek V4 Flash is very cheap, but it's still worth setting a **credit limit on the key** in OpenRouter (Keys → Edit → Limit) so there's a hard cap. If you ever want logins, set `ALEX_REQUIRE_LOGIN=true`. The cookie-signing secret is generated automatically, so there's still nothing to create by hand.

## Alternative: Docker Compose

In Dokploy choose **Create Service → Compose**, point it at the repo (it uses `docker-compose.yml`), and set the same environment variables. Add the domain on service `alex`, port `8787`. The compose file already declares the `alex-data` volume.

Locally: `cp .env.example .env`, fill in the keys, uncomment `ports` in `docker-compose.yml`, run `docker compose up --build`, then open http://localhost:8787.

## Backups

Everything is in the `alex-data` volume. On the server:

```bash
docker run --rm -v alex-data:/data -v "$PWD":/backup busybox tar czf /backup/alex-data-$(date +%F).tgz -C /data .
```

Dokploy may prefix the volume name with the project name; check with `docker volume ls`.
