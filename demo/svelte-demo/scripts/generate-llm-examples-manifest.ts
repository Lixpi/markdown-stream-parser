// This script scans demo/llm-streams-examples for *.json files and writes a manifest to static/llm-examples-manifest.json
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXAMPLES_DIR = path.resolve(__dirname, '../../llm-streams-examples');
const STATIC_DIR = path.resolve(__dirname, '../static');
const MANIFEST_PATH = path.join(STATIC_DIR, 'llm-examples-manifest.json');

async function main() {
  const files = await fs.readdir(EXAMPLES_DIR);
  const jsons = files.filter(f => f.endsWith('.json'));
  const manifest = jsons.map(jsonFile => {
    const base = jsonFile.replace(/\.json$/, '');
    const txtFile = base + '.txt';
    return {
      base,
      json: `/llm-streams-examples/${jsonFile}`,
      txt: `/llm-streams-examples/${txtFile}`
    };
  });
  await fs.mkdir(STATIC_DIR, { recursive: true });
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`Wrote manifest with ${manifest.length} examples to ${MANIFEST_PATH}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
