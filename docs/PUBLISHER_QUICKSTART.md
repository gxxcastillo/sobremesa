# Quick Start Guide

## Prerequisites

### Install Bun.js

```bash
curl -fsSL https://bun.sh/install | bash
```

Then add to your PATH:

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

Or reload your shell:

```bash
exec $SHELL
```

## Start the System

### Terminal 1: Start the API Server

```bash
cd apps/api
bun run src/main.ts
```

Expected output:

```
📚 Studio API server running on http://localhost:3000
   Health check: http://localhost:3000/health
```

### Terminal 2: Start the Studio Frontend

```bash
nx serve studio
```

Expected output will show the Vite dev server starting on `http://localhost:4200`

### Terminal 3: Database (if needed)

If the database isn't already running:

```bash
pnpm db:start
```

## Testing

### API Health Check

```bash
curl http://localhost:3000/health
```

### Get Family Summary

```bash
curl http://localhost:3000/api/family/summary
```

### Using the UI

1. Open `http://localhost:4200` in your browser
2. Click "Generate Preview"
3. See the family summary rendered!

## Architecture

- **Frontend**: Solid.js app that displays the summary
- **API Client**: Reusable TypeScript library that handles HTTP communication
- **Backend**: Bun.js Express server that queries the database
- **Database**: Supabase connection (already configured)

## File Structure

```
sobremesa/
├── apps/
│   ├── api/                    # Bun.js API for the publishing app
│   ├── chatbots/               # Chat bot service
│   ├── db/                     # Supabase database
│   └── studio/                 # Solid.js frontend for studio content
├── libs/
│   ├── api-client/             # API client library
│   ├── database/               # Database layer (existing)
│   ├── agents/                 # AI agents (existing)
│   └── ...
└── ...
```

## What to Do Next

1. **Install Bun**: Follow the prerequisites above
2. **Start services**: Follow the "Start the System" section above
3. **Test the API**: Use curl or your browser
4. **Extend the API**: Add more endpoints in `apps/api/src/main.ts`
5. **Improve the UI**: Enhance `apps/studio/src/app/App.tsx`

Happy narrating! 📚✍️
