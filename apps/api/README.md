# API Server

A Bun.js Express API server for the Studio app.

## Features

- Family summary endpoints
- Narrative generation (stubbed)
- Book generation (stubbed)
- CORS-enabled for frontend access

## Running the server

### Prerequisites

Install [Bun](https://bun.sh):

```bash
curl -fsSL https://bun.sh/install | bash
```

### Development

```bash
cd apps/api
bun run src/main.ts
```

Or with Nx:

```bash
nx serve api
```

### Build

```bash
cd apps/api
bun build src/main.ts --outdir dist
```

## API Endpoints

### Health Check

```
GET /health
```

### Family Summary

Get the active family's summary:

```
GET /api/family/summary
```

Get a specific family's summary:

```
GET /api/family/:familyId/summary
```

Response:

```json
{
  "familyName": "The Smith Family",
  "people": [...],
  "relationships": [...],
  "places": [...],
  "events": [...],
  "stories": [...],
  "questions": {
    "proposed": 5,
    "asked": 2,
    "answered": 8
  }
}
```

### Generate Narrative

```
POST /api/narrative/generate

{
  "familyId": "uuid",
  "audience": "general"  // optional
}
```

### Generate Book

```
POST /api/book/generate

{
  "familyId": "uuid",
  "audience": "general"  // optional
}
```

## Environment

Port defaults to `3000`. Set `PORT` environment variable to override:

```bash
PORT=3001 bun run src/main.ts
```
