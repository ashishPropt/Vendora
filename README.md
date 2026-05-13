# Vendora — LeaseLoft Vendor Acquisition Engine

**Multi-Agent AI Platform for Nationwide Vendor Discovery, Deduplication, Classification & Scoring**

> v1.0 | Python + PostgreSQL + Redis | ArdouraAI / LeaseLoft

---

## Overview

A fully autonomous, locally-runnable Python system that discovers, deduplicates, classifies, scores, and serves property service vendors for the LeaseLoft platform.

| Agent | Role |
|-------|------|
| **Google Places Discovery** | Sweeps 41K ZIP centroids × 63 categories via Google Places API (New) |
| **Yelp Fusion Discovery** | Paginates all service vendors per DMA market |
| **Angi Playwright Scraper** | Headless scraper for Angi.com pro listings |
| **Deduplication Agent** | Multi-signal ensemble (phone 40%, name 25%, address 20%, domain 15%) |
| **Classification Agent** | 3-layer: rule engine → GPT-4o-mini → keyword fallback |
| **Scoring Agent** | Composite 0–100 score (quality + compliance + reputation + activity + coverage) |
| **Stream Consumer** | Ingests Redis Streams → PostgreSQL with full dedup/classify/score pipeline |
| **REST API** | FastAPI endpoints for vendor search, detail, flagging, pipeline status |

---

## Quick Start

**Prerequisites:** Python 3.11+, PostgreSQL 14+, Redis 6+

```bash
# 1. Install
git clone https://github.com/ashishPropt/Vendora.git
cd Vendora
pip install -r requirements.txt

# 2. Configure
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL and REDIS_URL

# 3. Create DB
psql -U postgres -c "CREATE DATABASE vendor_acquisition;"

# 4. Setup (tables + 63-category taxonomy + 7 sample vendors)
python main.py setup

# 5. Check status
python main.py status

# 6. Start API
python main.py api   # → http://localhost:8000/docs
```

---

## CLI Commands

```bash
python main.py setup          # Create DB + seed data
python main.py api            # Start REST API (port 8000)
python main.py discover       # Google Places sweep (needs GOOGLE_PLACES_API_KEY)
python main.py discover-yelp  # Yelp Fusion sweep (needs YELP_API_KEY)
python main.py consume        # Process Redis streams → PostgreSQL (continuous)
python main.py consume --once # Process one batch and exit
python main.py score          # Score all unscored vendors
python main.py classify       # Classify unclassified vendors
python main.py dedup          # Run deduplication batch
python main.py status         # Print pipeline stats (rich tables)
python main.py reset          # Drop + recreate all tables (DESTRUCTIVE)
```

---

## API Endpoints

```
GET  /api/v1/vendors                   paginated vendor list with filters
GET  /api/v1/vendors/search            full-text + geo search
GET  /api/v1/vendors/{vendor_id}       full detail + score breakdown
POST /api/v1/vendors/{vendor_id}/flag  flag vendor for review
GET  /api/v1/categories                full taxonomy tree (63 leaf nodes)
GET  /api/v1/pipeline/status           pipeline health + Redis queue depths
POST /api/v1/pipeline/trigger          queue a pipeline run
GET  /health                           health check
```

### Example queries

```bash
# Tier A/B plumbers in NJ
GET /api/v1/vendors?category_code=PLB.GEN&state=NJ&score_tier=A,B

# Emergency plumbers near Princeton, NJ (20mi radius)
GET /api/v1/vendors/search?q=emergency+plumber&lat=40.36&lng=-74.66&radius_miles=20

# Full vendor detail
GET /api/v1/vendors/{vendor_id}
```

---

## Score Model

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

## Database Schema

8 PostgreSQL tables (UUID PKs, TIMESTAMPTZ, JSONB, ARRAY):

| Table | Purpose |
|-------|---------|
| `vendors` | Canonical golden records |
| `vendor_sources` | Raw source data (JSONB), full provenance |
| `vendor_scores` | Append-only score history |
| `vendor_licenses` | State licensing records |
| `vendor_reviews_summary` | Per-source review aggregates |
| `category_taxonomy` | 63-leaf taxonomy with aliases |
| `job_runs` | Pipeline execution audit log |
| `dedup_pairs` | Deduplication candidate/merge log |

---

## Project Structure

```
Vendora/
├── main.py                    # CLI entrypoint (click + rich)
├── config.py                  # Settings (pydantic-settings + .env)
├── requirements.txt
├── .env.example
├── agents/
│   ├── discovery_google.py    # Agent 2: Google Places API (New)
│   ├── discovery_yelp_angi.py # Agents 3+4: Yelp Fusion + Angi Playwright
│   ├── dedup.py               # Agent 7: Multi-signal deduplication
│   ├── classification.py      # Agent 8: 3-layer classification
│   ├── scoring.py             # Agent 10: Composite scoring model
│   └── stream_consumer.py     # Redis Streams → PostgreSQL pipeline
├── api/
│   └── main.py                # FastAPI REST API
├── db/
│   ├── models.py              # SQLAlchemy ORM (8 tables)
│   ├── connection.py          # Sync + async engines, PostGIS helpers
│   └── seed.py                # Taxonomy + 7 sample vendor seeder
├── taxonomy/
│   └── __init__.py            # All 63 leaf-node categories + lookup maps
├── utils/
│   └── __init__.py            # Redis rate limiter, circuit breaker, normalizers
└── geo/
    └── __init__.py            # ZIP centroid loader (add zip_centroids.csv for full coverage)
```

---

## Minimum `.env`

```env
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/vendor_acquisition
REDIS_URL=redis://localhost:6379/0
```

API keys (Google Places, Yelp, OpenAI) are optional — the engine runs in seed/score/dedup mode without them.

---

*Vendora v1.0 | ArdouraAI Confidential*
