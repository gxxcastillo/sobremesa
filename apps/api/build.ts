import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import type { BunPlugin } from 'bun';

// Plugin to handle ?raw imports like Vite. Bun's runtime resolves `?raw`
// (so `bun run src/main.ts` works) but its bundler does not, and the API
// bundles libs/prompts via the import pipeline. Same plugin as
// apps/chatbots/build.ts.
const rawTextLoader: BunPlugin = {
  name: 'raw-text-loader',
  setup(build) {
    // Intercept imports with ?raw suffix before Bun tries to resolve them
    build.onResolve({ filter: /\?raw$/ }, (args) => {
      const cleanPath = args.path.replace(/\?raw$/, '');
      const resolvedPath = resolve(dirname(args.importer), cleanPath);
      return {
        path: resolvedPath,
        namespace: 'raw-text',
      };
    });

    // Load files in our namespace as raw text
    build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => {
      const content = readFileSync(args.path, 'utf-8');
      return {
        contents: `export default ${JSON.stringify(content)}`,
        loader: 'js',
      };
    });
  },
};

const result = await Bun.build({
  entrypoints: ['./src/main.ts'],
  outdir: './dist',
  target: 'bun',
  loader: { '.txt': 'text' },
  plugins: [rawTextLoader],
});

if (!result.success) {
  console.error('Build failed:');
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log('Build succeeded!');
