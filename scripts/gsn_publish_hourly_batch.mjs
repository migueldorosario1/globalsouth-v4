import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const repo = process.cwd();
const queuePath = path.join(repo, 'tools', 'gsn_hourly_queue.json');
const statePath = path.join(repo, 'tools', 'gsn_hourly_state.json');
const logPath = path.join(repo, 'logs', 'gsn_publication_audit.jsonl');
const reportPath = path.join(repo, 'logs', 'gsn_relatorio_bloqueios.md');
const brainPath = path.join(repo, '..', 'CEREBRO_INDEX_GSN.md');
const blogDir = path.join(repo, 'src', 'content', 'blog');
const publicDir = path.join(repo, 'public');
const pausePath = path.join(repo, 'tools', 'gsn_publish_paused.txt');

fs.mkdirSync(path.dirname(queuePath), { recursive: true });
fs.mkdirSync(path.dirname(logPath), { recursive: true });

const args = new Set(process.argv.slice(2));
const envPath = path.join(repo, '..', 'root', 'chaves_gsn.env');
const forcedBatchSize = process.env.GSN_BATCH_SIZE ? Number(process.env.GSN_BATCH_SIZE) : null;
const forcedMaxAuditAttempts = process.env.GSN_MAX_AUDIT_ATTEMPTS ? Number(process.env.GSN_MAX_AUDIT_ATTEMPTS) : null;
const forcedMaxBatchSize = process.env.GSN_MAX_BATCH_SIZE ? Number(process.env.GSN_MAX_BATCH_SIZE) : null;
const defaultBatchSize = 10;
const auditCurrentOnly = args.has('--audit-current');
const reAuditVisible = auditCurrentOnly || args.has('--reaudit-visible') || process.env.GSN_REAUDIT_VISIBLE === '1';
const commitAndPush = args.has('--commit') && !auditCurrentOnly;
const skipGitPush = args.has('--no-push');
const deployVercel = args.has('--vercel-deploy');
const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
let state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
  : { nextBatchSize: defaultBatchSize, round: 1 };

if (fs.existsSync(pausePath) && !auditCurrentOnly) {
  const reason = fs.readFileSync(pausePath, 'utf8').replace(/\s+/g, ' ').trim().slice(0, 240);
  console.log(`Publicacao automatica GSN pausada: ${reason}`);
  process.exit(0);
}

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function splitFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('frontmatter ausente');
  return { frontmatter: match[1], body: match[2] };
}

function getField(frontmatter, field) {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim().replace(/^"|"$/g, '') : '';
}

function parseTags(frontmatter) {
  const raw = getField(frontmatter, 'tags');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((tag) => String(tag));
  } catch {}
  return raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((tag) => tag.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function primaryCategoryFromTags(tags) {
  const priority = [
    'multipolar-world',
    'brics',
    'development',
    'trade',
    'latin-america',
    'africa',
    'asia',
    'west-asia',
    'infrastructure',
    'energy',
    'technology',
  ];
  return priority.find((tag) => tags.includes(tag)) || tags[0] || 'sem-categoria';
}

const PORTUGUESE_MARKERS = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na', 'nos', 'nas',
  'que', 'para', 'com', 'por', 'sobre', 'como', 'mais', 'foi', 'sao', 'são', 'esta', 'está', 'este',
  'nesta', 'neste', 'ao', 'aos', 'pela', 'pelo', 'pelas', 'pelos', 'entre', 'contra', 'apos', 'após',
  'ate', 'até', 'governo', 'policia', 'polícia', 'camara', 'câmara', 'cidade', 'estado',
  'moradores', 'municipio', 'município', 'seguranca', 'segurança', 'saude', 'saúde',
  'educacao', 'educação', 'transporte', 'justica', 'justiça'
]);

const ENGLISH_MARKERS = new Set([
  'the', 'and', 'of', 'to', 'in', 'for', 'with', 'without', 'from', 'this', 'that', 'what', 'why', 'who',
  'have', 'has', 'been', 'are', 'is', 'was', 'were', 'claim', 'claims', 'residents', 'social', 'costs',
  'data', 'centers', 'big', 'tech', 'hub', 'water', 'day', 'movements', 'right', 'began', 'occupation',
  'talks', 'waste', 'pickers', 'sustainability', 'retraining', 'after', 'before', 'police', 'city',
  'hall', 'port', 'railway', 'corridor', 'summit', 'development', 'trade', 'women', 'memory'
]);

function countMarkers(text, markers) {
  const tokens = String(text || '').toLowerCase().match(/[a-zA-ZÀ-ÿ]+/g) || [];
  return tokens.filter((token) => markers.has(token)).length;
}

function portugueseAccentBonus(text) {
  const matches = String(text || '').match(/[áàâãéêíóôõúüç]/gi);
  return matches ? Math.min(matches.length, 12) : 0;
}

function languageCheck(article) {
  const title = article.title || '';
  const sample = `${article.title || ''}\n${article.description || ''}\n${String(article.body || '').slice(0, 2600)}`;
  const english = countMarkers(sample, ENGLISH_MARKERS);
  const portuguese = countMarkers(sample, PORTUGUESE_MARKERS) + portugueseAccentBonus(sample);
  const bodyLooksPortuguese = portuguese >= 14 && portuguese > english * 1.25;

  if (bodyLooksPortuguese) {
    return {
      ok: false,
      reason: `article appears non-English/Portuguese: markers_en=${english}, markers_pt=${portuguese}`,
    };
  }
  return { ok: true };
}

function orderHiddenByDiversity(files) {
  const buckets = new Map();
  const freshness = (file) => {
    const match = file.match(/(?:^|-)20\d{10}/);
    if (match) return Number(match[0].replace(/^-/, ''));
    return 0;
  };
  for (const file of files) {
    try {
      const text = fs.readFileSync(path.join(blogDir, file), 'utf8');
      const { frontmatter } = splitFrontmatter(text);
      const category = primaryCategoryFromTags(parseTags(frontmatter));
      if (!buckets.has(category)) buckets.set(category, []);
      buckets.get(category).push(file);
    } catch {
      if (!buckets.has('erro-leitura')) buckets.set('erro-leitura', []);
      buckets.get('erro-leitura').push(file);
    }
  }
  for (const items of buckets.values()) {
    items.sort((a, b) => freshness(b) - freshness(a));
  }

  let bucketList = [...buckets.values()].sort((a, b) => freshness(b[0] || '') - freshness(a[0] || ''));
  const ordered = [];
  while (bucketList.some((items) => items.length)) {
    for (const items of bucketList) {
      if (items.length) ordered.push(items.shift());
    }
    bucketList = bucketList
      .filter((items) => items.length)
      .sort((a, b) => freshness(b[0] || '') - freshness(a[0] || ''));
  }
  return ordered;
}

function setDraft(frontmatter, draft) {
  if (frontmatter.match(/^draft:\s*(true|false)\s*$/m)) {
    return frontmatter.replace(/^draft:\s*(true|false)\s*$/m, `draft: ${draft ? 'true' : 'false'}`);
  }
  return `${frontmatter}\ndraft: ${draft ? 'true' : 'false'}`;
}

const KNOWN_SOURCE_NAMES = {
  'agenciabrasil.ebc.com.br': 'Agência Brasil',
  'english.news.cn': 'Xinhua',
  'news.cgtn.com': 'CGTN',
  'aljazeera.com': 'Al Jazeera',
  'reuters.com': 'Reuters',
  'africanews.com': 'Africanews',
  'telesurenglish.net': 'teleSUR English',
  'thehindu.com': 'The Hindu',
  'globaltimes.cn': 'Global Times',
  'presstv.ir': 'Press TV',
};

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isKnownHost(url) {
  const h = hostnameFromUrl(url);
  return h !== null && Object.prototype.hasOwnProperty.call(KNOWN_SOURCE_NAMES, h);
}

function sourceNameFromUrl(url) {
  const hostname = hostnameFromUrl(url);
  if (!hostname) return 'fonte original';
  return KNOWN_SOURCE_NAMES[hostname] || hostname.split('.')[0].replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function cleanSourceName(name, url) {
  // Blacklist: nomes placeholder ou proibidos (diretrizes editoriais GSN).
  // Sempre derivam do URL via sourceNameFromUrl. Fix BUG-20260513-SARMAT §51.
  const cleaned = String(name || '')
    .replace(/^publica[cç][aã]o original$/i, '')
    .replace(/^fonte original$/i, '')
    .replace(/^ag[êe]ncia internacional$/i, '')
    .trim();
  return cleaned || sourceNameFromUrl(url);
}

function normalizeSourceCredits(body) {
  return body
    .replace(/\*Fonte para revisão: \[([^\]]+)\]\(([^)]+)\)\.\*/g, (_match, name, url) => `*Fonte: [${cleanSourceName(name, url)}](${url}).*`)
    .replace(/\*Fonte: \[([^\]]+)\]\(([^)]+)\)\.\*/gi, (_match, name, url) => {
      // Se hostname está no mapa explícito, SEMPRE sobrepõe nome existente (mesmo se for "Agência Internacional" ou similar errado herdado do coletor).
      if (isKnownHost(url)) {
        return `*Fonte: [${sourceNameFromUrl(url)}](${url}).*`;
      }
      // Senão, só limpa "publicação original" / "fonte original" preservando outros nomes.
      return `*Fonte: [${cleanSourceName(name, url)}](${url}).*`;
    });
}

function splitSentences(paragraph) {
  const sentences = paragraph
    .replace(/\s+/g, ' ')
    .trim()
    .match(/[^.!?]+(?:[.!?]+["”’']?|$)/g);
  return sentences?.map((item) => item.trim()).filter(Boolean) || [paragraph.trim()];
}

function shortParagraphs(body) {
  return body
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (
        trimmed.startsWith('*Fonte:') ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('>') ||
        trimmed.startsWith('- ') ||
        trimmed.includes('<') ||
        trimmed.includes('```')
      ) {
        return trimmed;
      }
      const lines = trimmed.split(/\n+/).map((line) => line.trim()).filter(Boolean);
      const paragraphs = [];
      for (const line of lines) {
        const sentences = splitSentences(line);
        for (let index = 0; index < sentences.length; index += 2) {
          paragraphs.push(sentences.slice(index, index + 2).join(' '));
        }
      }
      return paragraphs.join('\n\n');
    })
    .join('\n\n');
}

function normalizeComparable(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[#*_`>\[\]()]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function sameHeadline(left, right) {
  const a = normalizeComparable(left);
  const b = normalizeComparable(right);
  if (!a || !b) return false;
  return a === b || (a.length > 35 && b.length > 35 && (a.startsWith(b) || b.startsWith(a)));
}

function stripLeadingRepeatedTitle(body, title) {
  const lines = String(body || '').replace(/^\s+/, '').split(/\r?\n/);
  while (lines.length && !lines[0].trim()) lines.shift();
  const first = (lines[0] || '').replace(/^#{1,6}\s+/, '').trim();
  if (sameHeadline(first, title)) {
    lines.shift();
    while (lines.length && !lines[0].trim()) lines.shift();
    return lines.join('\n').trim();
  }
  return String(body || '').trim();
}

function stripTitlePrefix(text, title) {
  const value = String(text || '').trim();
  if (!value || !normalizeComparable(title)) return value;
  const words = value.split(/\s+/);
  for (let count = Math.min(words.length, 32); count >= 4; count -= 1) {
    const prefix = words.slice(0, count).join(' ').replace(/[.:;,-]+$/g, '');
    if (sameHeadline(prefix, title)) {
      return words.slice(count).join(' ').replace(/^[-:;,.\s]+/, '').trim() || value;
    }
  }
  return value;
}

function setQuotedField(frontmatter, field, value) {
  const escaped = String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const line = `${field}: "${escaped}"`;
  if (frontmatter.match(new RegExp(`^${field}:\\s*.+$`, 'm'))) {
    return frontmatter.replace(new RegExp(`^${field}:\\s*.+$`, 'm'), line);
  }
  return `${frontmatter}\n${line}`;
}

function cleanBody(body, title = '') {
  const cleaned = stripLeadingRepeatedTitle(body, title)
    .replace(/^> Rascunho técnico de smoke\. Revisar edição, categoria e imagem antes de publicar\.\n\n/m, '')
    .replace(/^Compartilhe:\s*$/gim, '')
    .trim();
  return `${shortParagraphs(normalizeSourceCredits(cleaned)).trimEnd()}\n`;
}

function extractSource(body) {
  const match = normalizeSourceCredits(body).match(/\*Fonte:\s*\[([^\]]+)\]\(([^)]+)\)\.\*/i);
  if (!match) return { name: '', url: '' };
  return { name: match[1].trim(), url: match[2].trim() };
}

function parseAuditorJson(raw) {
  const cleaned = String(raw || '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const candidates = [
    cleaned,
    cleaned.match(/\{[\s\S]*\}/)?.[0],
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === 'string') return parseAuditorJson(parsed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return null;
}

function normalizeVote(auditor, json, raw) {
  const lowerRaw = String(raw || '').toLowerCase();
  const reason = String(json?.reason || '').replace(/\s+/g, ' ').trim();
  const fix = String(json?.fix || '').replace(/\s+/g, ' ').trim();
  const lowQuality =
    (!reason && !fix) ||
    ['curto', 'ok', 'aprovado', 'aprovada'].includes(reason.toLowerCase()) ||
    (reason.toLowerCase() === 'curto' && fix.toLowerCase() === 'curto');

  if (json?.ok === false && lowQuality) {
    return { auditor: auditor.name, ok: null, reason: 'veto vazio/curto ignorado como falha tecnica' };
  }
  if (json?.ok === true && lowQuality) {
    return { auditor: auditor.name, ok: null, reason: 'aprovacao vazia/curta ignorada como voto fraco' };
  }
  if (json?.ok === false && /\b(timestamp|nome do arquivo|filename|heroimage|imagem.*2026|202605)\b/i.test(reason)) {
    return { auditor: auditor.name, ok: null, reason: `veto por metadado tecnico ignorado: ${reason.slice(0, 180)}` };
  }
  if (!json && lowerRaw) {
    return {
      auditor: auditor.name,
      ok: lowerRaw.includes('"ok":true') || lowerRaw.includes('ok: true') || lowerRaw.includes('aprov'),
      reason: String(raw).replace(/\s+/g, ' ').slice(0, 180),
    };
  }
  if (!json) return { auditor: auditor.name, ok: null, reason: 'resposta sem JSON util' };
  return { auditor: auditor.name, ok: Boolean(json.ok), reason, fix };
}

function brainNotes() {
  const notes = [];
  const brain = fs.existsSync(brainPath) ? fs.readFileSync(brainPath, 'utf8') : '';
  if (brain.includes('Media DB') || brain.includes('mídia')) {
    notes.push('imagens devem ficar dentro do silo GSN antes do deploy');
  }
  if (brain.includes('Markdown') || brain.includes('Astro')) {
    notes.push('publicação correta é Markdown/Astro/Vercel, não WordPress');
  }
  notes.push('falha editorial crítica deve segurar a publicação, corrigir e tentar novamente');
  return notes;
}

function summarizeReason(reason) {
  if (!reason) return 'sem motivo registrado';
  return reason
    .replace(/auditoria ampliada sem mais de 3 votos [^:]+:\s*/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 420);
}

function readAuditEvents() {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function writeHourlyReport(extra = {}) {
  const events = readAuditEvents();
  const blocked = events.filter((event) => event.blocked);
  const latest = new Map();
  for (const event of blocked) latest.set(event.file, event);
  const published = events.filter((event) => event.published);
  const notes = brainNotes();
  const lines = [
    '# Global South News - Relatorio horario de bloqueios',
    '',
    `Atualizado em: ${new Date().toISOString()}`,
    `Publicadas/auditadas com sucesso no historico: ${published.length}`,
    `Materias com bloqueio acumulado: ${latest.size}`,
    '',
    '## Solucoes do cerebro aplicadas',
    ...notes.map((note) => `- ${note}`),
    '',
    '## Bloqueios acumulados',
  ];
  if (latest.size === 0) {
    lines.push('- Nenhum bloqueio acumulado ate agora.');
  } else {
    for (const event of latest.values()) {
      lines.push(`- ${event.file}: ${summarizeReason(event.reason)}`);
    }
  }
  if (extra.published?.length) {
    lines.push('', '## Publicadas nesta rodada', ...extra.published.map((file) => `- ${file}`));
  }
  if (extra.retained?.length) {
    lines.push('', '## Retidas nesta rodada', ...extra.retained.map((item) => `- ${item.file}: ${summarizeReason(item.reason)}`));
  }
  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`);
}

async function applyBrainFixes(file, context = {}) {
  const fullPath = path.join(blogDir, file);
  let text = fs.readFileSync(fullPath, 'utf8');
  let { frontmatter, body } = splitFrontmatter(text);
  let heroImage = getField(frontmatter, 'heroImage');
  const isRemoteHero = heroImage && (heroImage.startsWith('http://') || heroImage.startsWith('https://'));
  let heroPath = (!heroImage || isRemoteHero) ? null : path.join(publicDir, heroImage.replace(/^\//, ''));
  const applied = [];

  const cleanedBody = cleanBody(body, getField(frontmatter, 'title'))
    .replace(/\ncontinua após as imagens\n/gi, '\n')
    .replace(/\nVeja o vídeo abaixo[^\n]*\n/gi, '\n');
  if (cleanedBody !== body) {
    text = `---\n${frontmatter}\n---\n${cleanedBody}`;
    fs.writeFileSync(fullPath, text);
    applied.push('limpeza de marcas internas/fonte conforme padrao Markdown GSN');
  }

  if (heroPath && fs.existsSync(heroPath)) {
    const stats = fs.statSync(heroPath);
    const sizeKB = stats.size / 1024.0;
    const isPng = heroPath.toLowerCase().endsWith('.png');

    if (sizeKB > 300 || isPng) {
      try {
        const meta = await sharp(heroPath).metadata();
        let pipeline = sharp(heroPath);

        if (meta.hasAlpha) {
          pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
        }

        // Resize to fit inside 1200x1200, keeping aspect ratio (no crop!)
        pipeline = pipeline.resize({
          width: 1200,
          height: 1200,
          fit: 'inside',
          withoutEnlargement: true
        });

        // Optimization loop: compress in-memory buffer until size is under 300KB
        let quality = 82;
        let buffer;
        do {
          buffer = await pipeline.clone().jpeg({ quality, chromaSubsampling: '4:2:0' }).toBuffer();
          if (buffer.length / 1024.0 <= 300 || quality <= 50) {
            break;
          }
          quality -= 5;
        } while (quality > 50);

        const targetJpgPath = heroPath.replace(/\.[^.]+$/, '.jpg');
        
        // If the source was a different file type (PNG), delete it first
        if (targetJpgPath !== heroPath) {
          fs.unlinkSync(heroPath);
        }
        
        fs.writeFileSync(targetJpgPath, buffer);

        const newStats = fs.statSync(targetJpgPath);
        const newSizeKB = newStats.size / 1024.0;
        const newHeroImage = heroImage.replace(/\.[^.]+$/, '.jpg');

        frontmatter = setQuotedField(frontmatter, 'heroImage', newHeroImage);
        text = `---\n${frontmatter}\n---\n${cleanedBody}`;
        fs.writeFileSync(fullPath, text);

        if (targetJpgPath !== heroPath) {
          applied.push(`imagem destacada PNG convertida para JPG otimizado: ${newHeroImage} (${newSizeKB.toFixed(1)} KB)`);
        } else {
          applied.push(`imagem destacada JPG pesada otimizada em lote: ${newHeroImage} (${newSizeKB.toFixed(1)} KB)`);
        }

        heroImage = newHeroImage;
        heroPath = targetJpgPath;
      } catch (err) {
        console.error(`Erro ao otimizar imagem ${heroPath}:`, err);
      }
    } else {
      const meta = await sharp(heroPath).metadata();
      if ((meta.width || 0) < 600 || (meta.height || 0) < 315) {
        await sharp(heroPath)
          .resize({ width: Math.max(1200, meta.width || 1200), withoutEnlargement: false })
          .toFile(`${heroPath}.tmp`);
        fs.renameSync(`${heroPath}.tmp`, heroPath);
        applied.push('imagem destacada pequena ampliada');
      }
    }
  }

  if (context.reason) {
    fs.appendFileSync(logPath, `${JSON.stringify({
      time: new Date().toISOString(),
      file,
      brainFixAttempt: true,
      applied,
      previousReason: summarizeReason(context.reason),
    })}\n`);
  }
  return applied;
}

async function askModelAuditor(auditor, article) {
  if (!auditor.key) return { auditor: auditor.name, ok: null, reason: 'chave ausente' };
  const now = new Date();
  const brNow = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(now);
  const prompt = [
    'Audite esta materia antes de publicacao no Global South News.',
    'Responda somente JSON: {"ok":true|false,"reason":"motivo objetivo","fix":"correcao objetiva ou vazio"}.',
    'A auditoria serve para ajudar a publicar melhor, nao para bloquear por medo generico.',
    'Criterios de bloqueio: contradicao interna grave, acusacao grave sem apoio no texto/fonte, data impossivel claramente demonstrada, titulo desonesto, aviso interno de rascunho.',
    'Nao bloqueie apenas porque voce nao lembra do fato. Nao use timestamp de nome de arquivo ou imagem como prova factual. Se houver fonte citada e voce nao tiver certeza do erro, aprove com observacao.',
    'Nao responda com "curto"; explique em uma frase concreta.',
    `Data/hora atual para auditoria: ${brNow} (America/Sao_Paulo). UTC: ${now.toISOString()}.`,
    'Use essa data dinamica para julgar passado, presente e futuro; nao invente data fixa.',
    `TITULO: ${article.title}`,
    `TAGS: ${article.tags}`,
    `FONTE CITADA: ${article.sourceName || 'sem fonte'} ${article.sourceUrl || ''}`,
    `IMAGEM: ${article.heroImage} ${article.imageSize}`,
    `TEXTO:\n${article.body.slice(0, 4500)}`,
  ].join('\n\n');
  try {
    const response = await fetch(`${auditor.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auditor.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: auditor.model,
        temperature: 0,
        max_tokens: 220,
        messages: [
          { role: 'system', content: 'Voce e um editor de checagem seco e conservador.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!response.ok) return { auditor: auditor.name, ok: null, reason: `HTTP ${response.status}` };
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    return normalizeVote(auditor, parseAuditorJson(raw), raw);
  } catch (error) {
    return { auditor: auditor.name, ok: null, reason: String(error.message || error).slice(0, 160) };
  }
}

const METAlanguage_PATTERNS = [
  { regex: /Editorial queue brief/i, reason: "placeholder 'Editorial queue brief'" },
  { regex: /Review headline,? category and image/i, reason: "placeholder 'Review headline'" },
  { regex: /before final publication/i, reason: "placeholder 'before final publication'" },
  { regex: /selected this item from its international monitoring queue/i, reason: "placeholder monitoring queue" },
  { regex: /This brief is intentionally concise and original/i, reason: "placeholder 'intentionally concise'" },
  { regex: /The item should be expanded by the editorial writer/i, reason: "placeholder 'expanded by editorial writer'" },
  { regex: /As an? (AI|language model|artificial intelligence)/i, reason: "metalinguagem 'As an AI'" },
  { regex: /I (cannot|apologize|'m sorry|am unable)/i, reason: "metalinguagem 'I cannot/apologize'" },
  { regex: /(Here|Below) is (the|your) (article|text|summary|response)/i, reason: "metalinguagem 'Here is the article'" },
  { regex: /I hope (this|you|it) (helps|find|enjoy)/i, reason: "metalinguagem 'I hope this helps'" },
  { regex: /Please note that/i, reason: "metalinguagem 'Please note that'" },
  { regex: /It is important to (note|remember|mention)/i, reason: "metalinguagem 'It is important to'" },
  { regex: /TITLE:|EDITORIAL:|SYS_PROMPT|SYSTEM:/i, reason: "prompt vazado (TITLE/EDITORIAL/SYS)" },
  { regex: /Write (a|an|the) (article|summary|response|text)/i, reason: "prompt vazado 'Write an article'" },
  { regex: /You are a (senior|copy|editor|writer|journalist)/i, reason: "prompt vazado 'You are a writer'" },
  { regex: /```json|```html|```markdown/i, reason: "markdown residual (```)" },
  { regex: /\(\[.*?\]\(https?:\/\/.*?\)\)/i, reason: "citação IA crua ([site](url))" }
];

function localVotes(article, warnings) {
  const textToCheck = `${article.title}\n${article.description}\n${article.body}`;
  const foundMetalanguage = [];
  for (const pattern of METAlanguage_PATTERNS) {
    if (pattern.regex.test(textToCheck)) {
      foundMetalanguage.push(pattern.reason);
    }
  }
  const hasMetalanguage = foundMetalanguage.length > 0;

  const textOk = article.body.length > 900 && 
                 !article.body.includes('Rascunho técnico') && 
                 !article.body.includes('Fonte para revisão') &&
                 !hasMetalanguage;
  const categoryOk = warnings.length === 0 || warnings.every((warning) => warning === 'titulo longo');
  const imageOk = article.imageSize === 'remote' || (!article.imageSize.startsWith('0x') && Number(article.imageSize.split('x')[0]) >= 600);

  const textReason = !textOk 
    ? (hasMetalanguage 
        ? `metalinguagem detectada: ${foundMetalanguage.join(', ')}` 
        : 'texto muito curto ou contendo marcadores de rascunho')
    : 'texto e categorias aceitaveis';

  return [
    { auditor: 'codex-texto-categoria', ok: textOk && categoryOk, reason: textOk && categoryOk ? 'texto e categorias aceitaveis' : `texto/categoria precisa revisao (${textReason})` },
    { auditor: 'codex-imagem-fonte', ok: imageOk, reason: imageOk ? 'imagem destacada aceitavel' : 'imagem destacada insuficiente' },
  ];
}

async function expandedConsensus(article, warnings) {
  if (args.has('--skip-chinese-audit')) return { passed: true, votes: [], skipped: true };
  const auditors = [
    {
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: process.env.DEEPSEEK_AUDIT_MODEL || 'deepseek-v4-pro',
      key: process.env.DEEPSEEK_API_KEY,
    },
    {
      name: 'kimi',
      baseUrl: 'https://api.moonshot.ai/v1',
      model: process.env.KIMI_AUDIT_MODEL || 'moonshot-v1-8k',
      key: process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY,
    },
    {
      name: 'qwen',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      model: process.env.QWEN_AUDIT_MODEL || 'qwen-plus',
      key: process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY,
    },
  ];
  const modelVotes = await Promise.all(auditors.map((auditor) => askModelAuditor(auditor, article)));
  const local = localVotes(article, warnings);
  const votes = [...modelVotes, ...local];
  const validExternal = modelVotes.filter((vote) => vote.ok !== null);
  const externalApprovals = validExternal.filter((vote) => vote.ok);
  const externalRejections = validExternal.filter((vote) => vote.ok === false);
  const localFailures = local.filter((vote) => vote.ok === false);
  const approvals = votes.filter((vote) => vote.ok).length;

  let passed = true;
  let decisionReason = 'auditoria ajudou sem veto consistente';
  if (localFailures.length) {
    passed = false;
    decisionReason = `falha local critica: ${localFailures.map((vote) => vote.reason).join('; ')}`;
  } else if (externalRejections.length >= 2) {
    passed = false;
    decisionReason = `veto externo consistente: ${externalRejections.map((vote) => `${vote.auditor}: ${vote.reason}`).join(' | ')}`;
  } else if (externalRejections.length === 1 && externalApprovals.length === 0 && !article.sourceUrl) {
    passed = false;
    decisionReason = `veto externo isolado sem fonte citada: ${externalRejections[0].auditor}: ${externalRejections[0].reason}`;
  }

  return {
    passed,
    votes,
    approvals,
    externalApprovals: externalApprovals.length,
    externalRejections: externalRejections.length,
    decisionReason,
  };
}

async function auditAndFix(file, publish) {
  const fullPath = path.join(blogDir, file);
  let text = fs.readFileSync(fullPath, 'utf8');
  const { frontmatter, body } = splitFrontmatter(text);
  const title = getField(frontmatter, 'title');
  const heroImage = getField(frontmatter, 'heroImage');
  const description = getField(frontmatter, 'description');
  const tags = getField(frontmatter, 'tags');
  const isRemoteHero = heroImage && (heroImage.startsWith('http://') || heroImage.startsWith('https://'));
  const heroPath = (!heroImage || isRemoteHero) ? null : path.join(publicDir, heroImage.replace(/^\//, ''));
  const warnings = [];

  if (!title || title.length < 20) warnings.push('titulo fraco ou ausente');
  if (title.length > 125) warnings.push('titulo longo');
  if (!description || description.length < 80) warnings.push('descricao curta');
  if (!/(multipolar|brics|development|trade|latin-america|africa|asia|west-asia|infrastructure|energy|technology)/i.test(tags)) {
    warnings.push('categoria GSN fraca');
  }
  let imageSize = 'remote';

  if (!isRemoteHero && heroPath) {
    if (!fs.existsSync(heroPath)) {
      console.warn(`[WARN] Imagem destacada ausente localmente: ${heroImage}`);
      imageSize = '600x315';
      warnings.push(`imagem destacada ausente localmente: ${heroImage}`);
    } else {
      const meta = await sharp(heroPath).metadata();
      imageSize = `${meta.width}x${meta.height}`;
      if ((meta.width || 0) < 600 || (meta.height || 0) < 315) {
        const warning = `imagem destacada pequena: ${heroImage} ${imageSize}`;
        if (publish) throw new Error(warning);
        warnings.push(warning);
      }
    }
  }

  let nextBody = cleanBody(body, title);
  const nextDescription = stripTitlePrefix(description, title);
  const source = extractSource(nextBody);
  const language = languageCheck({ title, description, body: nextBody });
  if (!language.ok) warnings.push(language.reason);
  const articleForAudit = {
        title,
        description,
        heroImage,
        tags,
        body: nextBody,
        imageSize,
        sourceName: source.name,
        sourceUrl: source.url,
  };
  const consensus = publish
    ? await expandedConsensus(articleForAudit, warnings)
    : { passed: true, votes: [] };
  if (publish && !consensus.passed) {
    throw new Error(`auditoria reteve ${file}: ${consensus.decisionReason}; votos=${JSON.stringify(consensus.votes)}`);
  }

  let nextFrontmatter = setDraft(frontmatter, !publish);
  if (nextDescription && nextDescription !== description) nextFrontmatter = setQuotedField(nextFrontmatter, 'description', nextDescription);
  const nextText = `---\n${nextFrontmatter}\n---\n${nextBody}`;
  if (nextText !== text) fs.writeFileSync(fullPath, nextText);

  const audit = {
    time: new Date().toISOString(),
    file,
    published: publish,
    title,
    heroImage,
    imageSize,
    warnings,
    expandedAudit: consensus.votes,
    approvals: consensus.approvals,
    externalApprovals: consensus.externalApprovals,
    externalRejections: consensus.externalRejections,
    auditDecision: consensus.decisionReason,
  };
  fs.appendFileSync(logPath, `${JSON.stringify(audit)}\n`);
  return { file, warnings };
}

const visible = [];
const hidden = [];
for (const file of queue) {
  const fullPath = path.join(blogDir, file);
  if (!fs.existsSync(fullPath)) {
    fs.appendFileSync(logPath, `${JSON.stringify({
      time: new Date().toISOString(),
      file,
      published: false,
      blocked: true,
      reason: 'arquivo da fila ausente; item ignorado para nao derrubar o publicador remoto',
    })}\n`);
    continue;
  }
  const text = fs.readFileSync(fullPath, 'utf8');
  if (text.match(/^draft:\s*false\s*$/m)) visible.push(file);
  else hidden.push(file);
}

const requestedBatchSize = forcedBatchSize || state.nextBatchSize || defaultBatchSize;
const maxBatchSize = forcedMaxBatchSize || defaultBatchSize;
const batchSize = auditCurrentOnly ? 0 : Math.min(requestedBatchSize, maxBatchSize);
const maxAuditAttempts = Math.max(batchSize, forcedMaxAuditAttempts || batchSize * 3);
let nextBatch = [];
if (!auditCurrentOnly && hidden.length === 0) {
  console.log('Fila encerrada: nenhuma materia pendente.');
  process.exit(0);
}

const results = [];
if (reAuditVisible) {
  for (const file of visible) {
    try {
      results.push(await auditAndFix(file, true));
    } catch (error) {
      // Fix Claude 2026-05-13 16:50 BRT (autorização Miguel "recomendo a, vamos corrigir logo"):
      // Matéria já-publicada perdeu consenso na re-auditoria. Antes: throw fatal parava
      // TODO o batch. Agora: rebaixa pra draft (esconde do público), loga e CONTINUA.
      const reason = String(error.message || error);
      fs.appendFileSync(logPath, `${JSON.stringify({
        time: new Date().toISOString(),
        file,
        published: false,
        rebaixada_por_reaudit: true,
        reason: `re-auditoria de visible perdeu consenso: ${reason.slice(0, 320)}`,
      })}\n`);
      try {
        // publish=false faz setDraft(true) -> materia some do publico ate revisao humana.
        results.push(await auditAndFix(file, false));
        console.log(`Rebaixada por re-auditoria: ${file} — ${reason.slice(0, 220)}`);
      } catch (innerError) {
        console.log(`Erro ao rebaixar ${file}: ${String(innerError.message || innerError).slice(0, 220)}`);
      }
    }
  }
} else if (visible.length) {
  console.log(`Re-auditoria de materias ja publicadas pulada neste ciclo (${visible.length} visiveis). Use --reaudit-visible para vigia dedicado.`);
}

if (auditCurrentOnly) {
  for (const file of orderHiddenByDiversity(hidden)) {
    results.push(await auditAndFix(file, false));
  }
} else {
  let attemptedHidden = 0;
  for (const file of orderHiddenByDiversity(hidden)) {
    if (nextBatch.length >= batchSize) {
      results.push(await auditAndFix(file, false));
      continue;
    }
    if (attemptedHidden >= maxAuditAttempts) {
      fs.appendFileSync(logPath, `${JSON.stringify({
        time: new Date().toISOString(),
        published: false,
        blocked: true,
        reason: `limite de auditoria da rodada atingido (${attemptedHidden}/${maxAuditAttempts}); aguardando proximo ciclo`,
      })}\n`);
      break;
    }
    attemptedHidden += 1;
    try {
      await applyBrainFixes(file);
      results.push(await auditAndFix(file, true));
      nextBatch.push(file);
    } catch (error) {
      const firstReason = String(error.message || error);
      const applied = await applyBrainFixes(file, { reason: firstReason });
      if (applied.length) {
        try {
          results.push(await auditAndFix(file, true));
          nextBatch.push(file);
          continue;
        } catch (retryError) {
          error = retryError;
        }
      }
      fs.appendFileSync(logPath, `${JSON.stringify({
        time: new Date().toISOString(),
        file,
        published: false,
        blocked: true,
        reason: String(error.message || error),
      })}\n`);
      try {
        results.push(await auditAndFix(file, false));
      } catch {}
      console.log(`Retida pela auditoria: ${file} — ${String(error.message || error).slice(0, 220)}`);
    }
  }
  if (nextBatch.length === 0) {
    console.log('Nenhuma materia nova passou na auditoria deste ciclo.');
  }
}

const changedArticleSet = auditCurrentOnly
  ? [...new Set([...visible, ...hidden])]
  : [...new Set([...(reAuditVisible ? visible : []), ...nextBatch])];
const publishSet = auditCurrentOnly ? visible : nextBatch;

if (!auditCurrentOnly) {
  try {
    console.log('Migrando imagens hero para o Cloudflare R2 antes do build...');
    const pythonBin = process.env.GSN_PYTHON || 'python3';
    const migrationScript = path.join(repo, '..', 'root', 'gsn_migrar_hero_r2.py');
    execFileSync(pythonBin, [migrationScript, 'upload'], { cwd: repo, stdio: 'inherit' });
    execFileSync(pythonBin, [migrationScript, 'rewrite'], { cwd: repo, stdio: 'inherit' });
  } catch (err) {
    console.error('Falha ao rodar gsn_migrar_hero_r2.py:', err.message);
  }
}

execFileSync('npm', ['run', 'build'], {
  cwd: repo,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_OPTIONS: (process.env.NODE_OPTIONS || '') + ' --max-old-space-size=4096'
  }
});

if (!auditCurrentOnly) {
  state = {
    round: (state.round || 1) + 1,
    nextBatchSize: defaultBatchSize,
    lastBatchSize: nextBatch.length,
    lastRun: new Date().toISOString(),
  };
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

writeHourlyReport({ published: publishSet });

if (commitAndPush) {
  const heroImages = changedArticleSet
    .map((file) => {
      try {
        const text = fs.readFileSync(path.join(blogDir, file), 'utf8');
        const { frontmatter } = splitFrontmatter(text);
        const img = getField(frontmatter, 'heroImage');
        if (img && !img.startsWith('http://') && !img.startsWith('https://')) {
          return `public/${img.replace(/^\//, '')}`;
        }
      } catch (err) {
        console.warn(`Aviso: nao foi possivel ler ${file} para extrair imagem hero:`, err.message);
      }
      return null;
    })
    .filter(Boolean);
  const changedFiles = [
    'tools/gsn_hourly_queue.json',
    'tools/gsn_hourly_state.json',
    'package.json',
    'scripts/gsn_hourly_cron.sh',
    'scripts/gsn_publish_hourly_batch.mjs',
    'logs/gsn_publication_audit.jsonl',
    'logs/gsn_relatorio_bloqueios.md',
    'src/content.config.ts',
    'src/components/Interlinks.astro',
    'src/pages/blog/[...slug].astro',
    'src/pages/blog/index.astro',
    'src/pages/historico/[year].astro',
    'src/pages/historico/index.astro',
    'src/pages/index.astro',
    'src/pages/rss.xml.js',
    'src/pages/tags/[tag].astro',
    ...changedArticleSet
      .map((file) => `src/content/blog/${file}`)
      .filter((file) => fs.existsSync(path.join(repo, file))),
  ];
  for (const file of changedFiles) {
    if (fs.existsSync(path.join(repo, file))) {
      try {
        git(['add', file]);
      } catch {
        try {
          git(['add', '-f', file]);
        } catch (forceError) {
          console.warn(`Could not add file ${file}: ${forceError.message}`);
        }
      }
    }
  }
    const staged = git(['diff', '--cached', '--name-only']);
    if (staged) {
      const publishedTitles = publishSet.map((file) => path.basename(file, '.md')).join(', ');
    git(['commit', '-m', `Publish GSN hourly batch (${publishSet.length})`, '-m', publishedTitles]);
    if (!skipGitPush) {
      try { git(['pull', '--rebase', 'origin', 'main']); } catch (e) { console.warn('Pull failed:', e.message); } try {
        git(['pull', '--rebase', 'origin', 'main']);
      } catch (err) {
        console.warn('Pull failed:', err.message);
      }
      git(['push', 'origin', 'main']);
    }
    if (publishSet.length) {
      execFileSync(
        process.env.GSN_PYTHON || 'python3',
        [path.join(repo, '..', 'root', 'gsn_confirm_published.py'), ...publishSet],
        { cwd: repo, stdio: 'inherit' },
      );
    }
  }
}

if (deployVercel && !auditCurrentOnly) {
  execFileSync('npx', ['vercel', 'deploy', '--prod', '--yes'], { cwd: repo, stdio: 'inherit' });
}

console.log(`${auditCurrentOnly ? 'Auditado neste ciclo' : 'Publicado neste ciclo'}: ${publishSet.join(', ')}`);
for (const result of results.filter((item) => item.warnings.length)) {
  console.log(`Aviso ${result.file}: ${result.warnings.join('; ')}`);
}
