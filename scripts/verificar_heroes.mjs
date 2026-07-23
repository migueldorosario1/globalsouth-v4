#!/usr/bin/env node
/**
 * GUARDA DE HEROES (estrutural, 2026-07-23 — incidente Libéria):
 * nenhum post publicado pode ir para o build sem heroImage válida.
 * Roda no prebuild: se faltar imagem, o build FALHA e a Vercel não publica
 * uma versão do site com post sem capa. Melhor derrubar o deploy do que
 * ir ao ar sem imagem (diretriz Miguel: "postagem sem imagem não pode
 * acontecer").
 *
 * Verifica, para cada .md não-draft em src/content/blog:
 *   1. frontmatter tem heroImage
 *   2. o arquivo existe em public/ (heroes remotas http(s) passam direto)
 */
import fs from 'node:fs';
import path from 'node:path';

const blogDir = path.join(process.cwd(), 'src', 'content', 'blog');
const publicDir = path.join(process.cwd(), 'public');

function frontmatter(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const m = txt.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : '';
}

const problemas = [];
for (const nome of fs.readdirSync(blogDir)) {
  if (!nome.endsWith('.md') && !nome.endsWith('.mdx')) continue;
  const caminho = path.join(blogDir, nome);
  const fm = frontmatter(caminho);
  if (/^draft:\s*true/m.test(fm)) continue;

  const hero = (fm.match(/^heroImage:\s*["']?([^"'\n]+)["']?/m) || [])[1]?.trim();
  if (!hero) {
    problemas.push(`${nome}: sem heroImage no frontmatter`);
    continue;
  }
  if (/^https?:\/\//.test(hero)) continue; // hero remota: arquivo não fica no repo
  if (!fs.existsSync(path.join(publicDir, hero.replace(/^\//, '')))) {
    problemas.push(`${nome}: hero declarada mas ausente no disco (${hero})`);
  }
}

if (problemas.length) {
  console.error('\n❌ BUILD BLOQUEADO — posts sem imagem de capa:');
  for (const p of problemas) console.error(`   - ${p}`);
  console.error('\nCorrija com: agentes_tematicos/v4/resgate_hero.py --site globalsouth --varredura\n');
  process.exit(1);
}
console.log('✓ guarda de heroes: todos os posts publicados têm imagem de capa');
