# Vendora — LeaseLoft Vendor Acquisition & Onboarding Engine

**Multi-Agent AI Platform for Nationwide Vendor Discovery, Deduplication, Classification, Scoring & Onboarding**

> Python + Node.js + PostgreSQL + Redis | ArdouraAI / LeaseLoft

---

## Overview

Vendora has two layers:

1. **Data Pipeline (Python)** — discovers, deduplicates, classifies, and scores vendors nationwide
2. **Onboarding API (Node.js/Express)** — serves vendor search, manages onboarding, admin panel, bid workflow

---

## Node.js API (`/server`)

Express ESM API deployed on Ubuntu VPS (port 3001, behind nginx).

### Routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/vendor/onboard` | Vendor self-registration |
| POST | `/vendor/login` | Vendor portal login |
| GET | `/v3/businesses/search` | Search vendors by zip + category |
| POST | `/v3/vendor-invite` | Create invite link (API key or admin JWT) |
| GET | `/v3/vendor-invite/:token` | Get vendor prefill data for invite link |
| POST | `/admin/login` | Admin login → 8-hour JWT |
| GET | `/admin/vendors` | Search/filter vendors (admin JWT required) |

### Client pages (`/client/dist`)

| File | Purpose |
|------|---------|
| `onboard.html` | Vendor self-registration with invite prefill flow |
| `admin.html` | Admin panel — vendor search by state, invite generation, call scheduling (Vapi) |
| `vendor-portal.html` | Vendor dashboard — bids, messages, escrow, profile |

### Environment (`server/config.env`)
```
DB_URL=...
JWT_SECRET=...
ADMIN_PASSWORD=...
VAPI_API_KEY=...
VAPI_PHONE_NUMBER_ID=...
```

### Deploy
```bash
pm2 restart vendora-api
```

---

## Python Data Pipeline (`/agents`)

| Agent | Role |
|-------|------|
| **Google Places Discovery** | Sweeps 41K ZIP centroids × 63 categories via Google Places API (New) |
| **Yelp Fusion Discovery** | Paginates all service vendors per DMA market |
| **Angi Playwright Scraper** | Headless scraper for Angi.com pro listings |
| **Deduplication Agent** | Multi-signal ensemble (phone 40%, name 25%, address 20%, domain 15%) |
| **Classification Agent** | 3-layer: rule engine → GPT-4o-mini → keyword fallback |
| **Scoring Agent** | Composite 0–100 score (quality + compliance + reputation + activity + coverage) |
| **Stream Consumer** | Ingests Redis Streams → PostgreSQL with full dedup/classify/score pipeline |

### Quick Start
```bash
pip install -r requirements.txt
cp .env.example .env
python main.py setup
python main.py api   # → http://localhost:8000/docs
```

### Score Model
```
VendorScore = (Quality × 30%) + (Compliance × 25%) + (Reputation × 25%)
            + (Activity × 10%) + (Coverage × 10%)
            − Decay (−2 pts/month inactive, max −20)
```

| Tier | Score | Label |
|------|-------|-------|
| A | 80–100 | Preferred Vendor |
| B | 60–79  | Qualified Vendor |
| C | 40–59  | Provisional Vendor |
| D | 20–39  | Unverified Vendor |
| F | 0–19   | Disqualified |

---

*Vendora | ArdouraAI Confidential*
