import os
import socket
socket.setdefaulttimeout(10.0)
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "chaves_gsn.env"), override=True)
import sys
import json
import time
import random
import re
import unicodedata
import fcntl
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

import requests
import feedparser
import trafilatura
from gsn_carregar_chaves import BASE_DIR, AGENT_DATA_DIR


os.makedirs(AGENT_DATA_DIR, exist_ok=True)
BANCO_JSON = os.path.join(AGENT_DATA_DIR, "gsn_banco_artigos_brutos.json")
CONFIG_DIR = os.path.join(BASE_DIR, "config")
FONTES_REGIONAIS_JSON = os.path.join(CONFIG_DIR, "gsn_fontes_regionais.json")

# Fix BUG-20260513-SARMAT-FAILOPEN-RECUSA-META + fix sistêmico "Agência Internacional"
# (Claude 2026-05-13 16:13 BRT, consenso Trindade 5 OKs §51):
# Fallback de fonte_jornal SEMPRE deriva do URL — nunca mais "Agência Internacional" literal.
KNOWN_SOURCE_NAMES = {
    "agenciabrasil.ebc.com.br": "Agência Brasil",
    "aljazeera.com": "Al Jazeera",
    "news.cgtn.com": "CGTN",
    "english.news.cn": "Xinhua",
    "globaltimes.cn": "Global Times",
    "presstv.ir": "Press TV",
    "en.irna.ir": "IRNA English",
    "telesurenglish.net": "teleSUR English",
    "prensa-latina.cu": "Prensa Latina",
    "africanews.com": "Africanews",
    "thehindu.com": "The Hindu",
}

def nome_jornal_from_url(url: str) -> str:
    """Deriva nome do jornal a partir do URL. Fallback inteligente em vez de
    string literal "Agência Internacional" (proibida nas diretrizes editoriais)."""
    try:
        host = (urlparse(url).hostname or "").replace("www.", "")
        if not host:
            return "fonte original"
        if host in KNOWN_SOURCE_NAMES:
            return KNOWN_SOURCE_NAMES[host]
        return host.split(".")[0].replace("-", " ").title()
    except Exception:
        return "fonte original"


# Memória de postados (para nunca coletar pauta que o portal já deu)
MEMORY_FILE = os.path.join(BASE_DIR, "publicadas_gsn.jsonl")

# Blacklist de Domínios para Extração (famosos paywalls impossíveis ou lixo extremista/fake-news)
EXTRACTION_BLACKLIST = {
    "instagram.com", "facebook.com", "twitter.com", "x.com",
    "oglobo.globo.com", "valor.com.br", "valoreconomico.com.br", "valor.globo.com",
    "bbc.com", "bbc.co.uk", "euronews.com",
    "cbn.com.br", "gazetadopovo.com.br", "bol.uol.com.br",
    "veja.abril.com.br", "exame.com", "wsj.com", "nytimes.com",
    "ft.com", "economist.com", "bloomberg.com", "folha.uol.com.br", "estadao.com.br",
    "revistaoeste.com", "oantagonista.com.br", "oantagonista.com", "jovempan.com.br",
    "diariodocentrodomundo.com.br"
}

FONTE_NOME_BLACKLIST = {"dcm", "diario do centro do mundo", "diário do centro do mundo"}

def log(msg):
    dh = datetime.now(ZoneInfo("America/Sao_Paulo")).strftime("%H:%M:%S")
    print(f"[{dh}] [COLETOR-V2] {msg}", flush=True)

# =============================================================================
# INTELIGÊNCIA DE DESDUPLICAÇÃO E MEMÓRIA
# =============================================================================

def remove_accents(t):
    return "".join(c for c in unicodedata.normalize("NFKD", t or "") if not unicodedata.combining(c))

def normalize_title(t):
    t = remove_accents((t or "").lower())
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", t)).strip()

def normalize_key(t):
    return normalize_title(t).replace(" ", "-")


def _dominio_bloqueado(url):
    domain = urlparse(url or "").netloc.lower().replace("www.", "")
    return any(domain == b or domain.endswith("." + b) for b in EXTRACTION_BLACKLIST)


def _fonte_nome_bloqueada(nome):
    return normalize_title(nome or "") in FONTE_NOME_BLACKLIST


def _jaccard(a, b):
    sa = set(a.split())
    sb = set(b.split())
    if not sa and not sb: return 1.0
    if not sa or not sb: return 0.0
    return len(sa & sb) / len(sa | sb)

def load_historico_titulos():
    """Carrega títulos do banco jsonl de publicações do Global South News para evitar pautas velhas."""
    titles = set()
    if os.path.exists(MEMORY_FILE):
        try:
            with open(MEMORY_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    if not line.strip(): continue
                    try:
                        rec = json.loads(line)
                        t = rec.get("title", "")
                        if t: titles.add(normalize_title(t))
                    except: pass
        except Exception as e: log(f"Erro lendo memory_file: {e}")
    return titles

def _load_banco_locked(path):
    if not os.path.exists(path): return []
    try:
        with open(path, 'r', encoding='utf-8') as f:
            fcntl.flock(f, fcntl.LOCK_SH)
            try:
                return json.load(f)
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)
    except Exception as e:
        log(f"ERRO ao carregar banco {path}: {e}")
        return []

def _save_banco_locked(path, data):
    try:
        with open(path, 'w', encoding='utf-8') as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            try:
                json.dump(data, f, ensure_ascii=False, indent=4)
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)
    except Exception as e:
        log(f"ERRO ao salvar banco {path}: {e}")

def load_banco_bruto():
    return _load_banco_locked(BANCO_JSON)

REGIAO_ALIAS_GROUPS = {
    "asia": {"asia", "china", "india", "asean", "brics", "multipolar-world"},
    "africa": {"africa", "african-union", "development", "multipolar-world"},
    "latin-america": {"latin-america", "celac", "brics", "development"},
    "west-asia": {"west-asia", "middle-east", "iran", "energy"},
    "multipolar-world": {"multipolar-world", "brics", "development", "trade"},
}


def _fonte_bate_filtro(filtro, item):
    if not filtro:
        return True
    regiao_item = normalize_key(item.get("regiao", ""))
    nome_item = normalize_key(item.get("nome") or "")
    tipo_item = normalize_key(item.get("tipo", ""))
    cidade_item = normalize_key(item.get("cidade", ""))
    valores = {regiao_item, nome_item, tipo_item, cidade_item}
    grupo = REGIAO_ALIAS_GROUPS.get(filtro)
    if grupo:
        return bool(grupo & valores) or any(filtro in v or v in grupo for v in valores if v)
    return filtro in valores or filtro in regiao_item


def carregar_fontes_regionais(regiao=None):
    """Carrega o mapa vivo de RSS do silo Global South News.

    Mantem a lista de fontes fora do codigo para a Trindade/AG atualizarem sem
    mexer no coletor. So fontes enabled=true entram no ciclo automatico.
    """
    if not os.path.exists(FONTES_REGIONAIS_JSON):
        return []
    try:
        with open(FONTES_REGIONAIS_JSON, "r", encoding="utf-8") as f:
            data = json.load(f)
        filtro = normalize_key(regiao) if regiao else None
        fontes = []
        for item in data.get("fontes", []):
            if not item.get("enabled", True):
                continue
            nome = item.get("nome")
            url = item.get("url")
            if _fonte_nome_bloqueada(nome) or _dominio_bloqueado(url):
                log(f"Fonte bloqueada por regra editorial: {nome} ({url})")
                continue
            if filtro and not _fonte_bate_filtro(filtro, {**item, "nome": nome}):
                continue
            if nome and url:
                fontes.append({
                    "nome": nome,
                    "url": url,
                    "regiao": item.get("regiao", ""),
                    "cidade": item.get("cidade", ""),
                    "tipo": item.get("tipo", ""),
                    "tier": item.get("tier", ""),
                })
        if fontes:
            escopo = f" ({regiao})" if regiao else ""
            log(f"🗺️ Fontes regionais Global South News carregadas{escopo}: {len(fontes)}")
        return fontes
    except Exception as e:
        log(f"Falha carregando fontes regionais ({FONTES_REGIONAIS_JSON}): {e}")
        return []

def eh_duplicata(titulo_atual, titulos_velhos_normalizados, itens_banco_atual):
    """ Filtro rigoroso: URL idêntica, Jaccard > 0.60 com o banco ou com a memória do WP. """
    nt = normalize_title(titulo_atual)
    
    # Contra Banco Histórico WP
    for t_velho in titulos_velhos_normalizados:
        if _jaccard(nt, t_velho) >= 0.55:  # Pauta já postada recentemente no Global South News
            return True
            
    # Contra O Fila de Hoje do V9
    for art in itens_banco_atual:
        t_fila = normalize_title(art.get("titulo_original",""))
        if _jaccard(nt, t_fila) >= 0.60:
            return True
            
    return False

# =============================================================================
# INTELIGÊNCIA DE CURADORIA (IA)
# =============================================================================

FOCO_GLOBAL_SOUTH = """GLOBAL SOUTH NEWS:
APROVE apenas se a pauta tiver relevância clara para desenvolvimento, soberania,
infraestrutura, integração regional, BRICS, relações Sul-Sul, energia, comércio,
tecnologia, indústria, saúde pública, clima, sanções, moedas, logística ou conflitos
com impacto geopolítico real.
REPROVE sumariamente notícia localista, celebridades, crime sem impacto político,
release corporativo trivial, turismo leve, fofoca, esporte raso ou pauta sem vínculo
material com o Sul Global.
🚨 FILTRO DE CONTEÚDO DOMÉSTICO BRASILEIRO:
REPROVE sumariamente qualquer notícia ou pauta sobre operações policiais domésticas brasileiras (como operações da Polícia Federal - PF, p. ex. "Operação Sem Refino", buscas e apreensões locais, etc.), investigações criminais domésticas brasileiras, disputas partidárias nacionais/locais brasileiras, ou escândalos envolvendo políticos, governadores e prefeitos brasileiros (e.g. Cláudio Castro, Flávio Bolsonaro, etc.) que não tenham impacto diplomático ou geopolítico internacional de nível macro.
"""


def construir_foco_hiperlocal(regiao=None):
    escopo = f" Recorte atual: {regiao}." if regiao else ""
    return FOCO_GLOBAL_SOUTH + escopo


def curadoria_llm_rapida(titulo, texto_bruto, foco_str=None, titulos_recentes=None):
    diretriz_geral_str = ""
    try:
        with open(os.path.join(AGENT_DATA_DIR, "diretriz_geral.json"), "r", encoding="utf-8") as fd:
            d = json.load(fd)
            diretriz_geral_str = d.get("texto", "")
    except: pass

    # Prompt de filtragem rigorosa para o Global South News
    if foco_str:
        sys_prompt = f"""Sua meta é atuar como JUIZ RIGORIOSO DE FACT-CHECKING E CURADORIA. Leia o TÍTULO E RESUMO.
🚨 MODO GLOBAL SOUTH NEWS 🚨
Você deve APROVAR apenas matérias com ligação material com o recorte: [{foco_str}].
Se a matéria não tiver conexão clara com desenvolvimento, soberania, infraestrutura, integração regional, BRICS, relações Sul-Sul, energia, comércio, tecnologia, indústria, saúde pública, clima, sanções, moedas, logística ou conflito geopolítico relevante, responda REPROVADO.
Se a notícia parecer falsa, vazia, ou originada de site com histórico duvidoso (se conhecido), DEVOLVA REPROVADO.

🚨 RESTRIÇÃO GEOGRÁFICA/POLICIAL CRÍTICA:
Você DEVE REPROVAR sumariamente qualquer notícia sobre operações policiais domésticas brasileiras (como operações da Polícia Federal, p. ex. 'Operação Sem Refino', buscas e apreensões locais, etc.), investigações criminais domésticas brasileiras, ou disputas partidárias/eleitorais internas de políticos brasileiros (e.g. Cláudio Castro, governadores, deputados, etc.) que não tenham impacto geopolítico internacional real de nível macro. O Global South News é um portal internacional focado exclusivamente no Sul Global; notícias de polícia e política interna do Brasil são terminantemente PROIBIDAS e devem ser rejeitadas.

🚨 REGRA ANTI-REPETIÇÃO (MEMÓRIA RECENTE):
Pautas já publicadas recentemente:
{", ".join(list(titulos_recentes)[:30]) if titulos_recentes else 'Nenhum histórico.'}
Você DEVE REPROVAR a matéria se ela reportar exatamente o mesmo evento, acontecimento ou fato central de alguma pauta acima (mesmo com título diferente). O GSN só publica atualizações se houver um desdobramento material novo.

Além de aprovar, VOCÊ DEVE DAR UMA NOTA (score numérico de 0 a 10) medindo a Qualidade da Notícia (Tamanho, relevância da Fonte e gravidade do fato). Matérias rasas ganham nota baixa. Jornalismo profundo ganha 9+.
Se aprovar, preencha OBRIGATORIAMENTE uma categoria granular, para alimentar o arquivo editorial do Global South News.
Use categorias como:
- "multipolar-world"
- "brics"
- "development"
- "trade"
- "latin-america"
- "africa"
- "asia"
- "west-asia"
- "infrastructure"
- "energy"
- "technology"

Use tags hifenizadas, minúsculas e gerais. Não use taxonomia local de outros portais.

Se aprovar, responda no formato JSON EXATO:
{{"status": "APROVADO", "tags": "brics, development, trade", "categoria": "multipolar-world", "score": 8.5}}
ou {{"status": "REPROVADO"}}
"""
    else:
        sys_prompt = f"""Sua meta é atuar como DIRETOR DE CONTEÚDO E JUIZ FINAL (FACT-CHECKING PRIMÁRIO).
O seu trabalho é ler O TÍTULO E RESUMO e atribuir uma NOTA DE QUALIDADE (0 a 10). Se a notícia for considerada altamente relevante segundo os critérios informados, DEVOLVA OBRIGATORIAMENTE O JSON COM STATUS 'APROVADO' e um 'score' alto. Se a notícia parecer falsa, manipulativa ou inútil, não hesite em REPROVÁ-LA sumariamente!

ATENÇÃO POLIGLOTA: Você receberá textos originais em vários idiomas (Inglês, Francês, Espanhol, Árabe, Chinês, Russo, Alemão, Italiano, Grego, etc). Você é fluente em todos e deve ignorar o idioma original na hora da qualificação. Apenas julgue e responda baseado na relevância da pauta para o mundo. O texto que seus colegas agentes escreverão no futuro será sempre em Português.

🚨 REGRA ANTI-REPETIÇÃO (MEMÓRIA RECENTE):
Pautas já publicadas recentemente:
{", ".join(list(titulos_recentes)[:30]) if titulos_recentes else 'Nenhum histórico.'}
Você DEVE REPROVAR a matéria se ela reportar exatamente o mesmo evento, acontecimento ou fato central de alguma pauta acima (mesmo com título diferente). O GSN não publica "mais do mesmo".

CRITÉRIOS OBRIGATÓRIOS DO SCORE (0 a 10) - O SISTEMA DE PESOS EM 3 EIXOS:
Sua nota NÃO PODE SER ARBITRÁRIA. Ela deve OBRIGATORIAMENTE ser a soma dos seguintes eixos:

Eixo 1 (Fonte) [Max 3 pts]:
- +3 pts se vier do Sul Global/BRICS (TeleSUR, IRNA, Xinhua, Al Jazeera, Opera Mundi, Sputnik, RT).
- +2 pts se for jornalismo progressista brasileiro reconhecido (Brasil247, Fórum, Carta Capital).
- DCM/Diário do Centro do Mundo está bloqueado por decisão editorial: não pontue, não aprove e não use como fonte.
- +1 pt se for agência ocidental mainstream (Reuters, France24).
- Penalidade de -5 a -10 se for propaganda da Jovem Pan, Revista Oeste ou O Antagonista.
- Ignorar peso da fonte (0 pts) se for do G1/Poder360 sobre Geopolítica em vez de penalizar se a notícia for de fato real e impactante internacionalmente (apenas reduza credibilidade).

Eixo 2 (Densidade Literária) [Max 3 pts]:
- +3 a +4 pts: Furo impactante, acontecimento crucial do dia internacional ou artigo de Análise extenso.
- +2 a +3 pts: Notícias rotineiras internacionais autênticas,Hard News ou comunicados geopolíticos reais.
- 0 pts: Notinha estéril de dois parágrafos.

Eixo 3 (Hierarquia Temática) [Max 4 pts]:
- +4 pts: Política Nacional bombástica (STF, Planalto) E Conflitos de Geopolítica de alto peso (Guerras, Irã, BRICS).
- +3 pts: Novas Tecnologias de Elite (Inteligência Artificial, Chips, Inovação geopolítica).
- +2 pts: Grandes Infraestruturas (Setor Ferroviário, Trens, Metrô), Mobilidade Urbana e Macroeconomia.
- +1 pt: História Fantástica, Descobertas Históricas/Culturais relevantes.

Some os 3 Eixos e me devolva o resultado final no campo 'score' (MÁXIMO 10.0).

DIRETRIZ EDITORIAL (A LENTE DE CORTE OBRIGATÓRIA):
{diretriz_geral_str}

São APROVADOS (Hard News essenciais e Variedades Estratégicas) (Score 5.5 a 10):
- Geopolítica mundial, Guerras, Conflitos internacionais, BRICS.
- Governo Federal Brasileiro (Políticas de Lula, Fazenda, Haddad, Ministérios).
- STF, Congresso, Projetos de infraestrutura maciça.
- Macroeconomia, Dólar, Indústria.
- Tecnologia, Ciência, IA, Defesa e Inovação.
- Análises aprofundadas, Relatórios Especiais, Geoeconomia e Artigos de Opinião.
- Setor Ferroviário, Trens, Ferrovias, Metrôs e Mobilidade de grande porte.

São REPROVADOS (Lixo/Soft News ou material anti-editorial):
- Fofocas (BBB, famosos, namoros, traições, TV, Novelas).
- Esporte raso, Receitas de bolo, Dietas, Acidentes mecânicos, crimes passionais.
- NOTÍCIAS CORPORATIVAS TRIVIAIS E DE STARTUPS EXTRANGEIRAS: Acusações de problemas em produtos ou resultados de vendas/balanços de startups gringas e empresas de nicho (como Lucid, Rivian, etc). Aprove apenas se o impacto diplomático ou macroeconômico for gigantesco.
- MATÉRIAS CONTRA O CAMPO PROGRESSISTA: Acusações, denúncias ou escândalos contra Lula, Governo Federal, Haddad, ou Ministros do STF. Isso deve ser REPROVADO sumariamente para não furar a linha editorial.
- NOTA DE CORTE: Geopolítica de canais mainstream (G1/Globo/Poder360) não devem ser sumariamente banidas se forem APENAS reporte factual de guerras (foco no fato). Apenas corte se for opinião alinhada pró-imperialismo.
- NOTA DE CORTE DE CONFIABILIDADE (PODER360): Dê um "score" muito baixo de credibilidade para notícias do Poder360.
- FALSIFICAÇÃO TEMPORAL: Se a matéria falar de um evento futuro com tom de passado, é fake news de IA. REPUDIE AGRESSIVAMENTE (REPROVADO).

Responda SOMENTE NO FORMATO JSON PURO, ESTRITAMENTE VÁLIDO. O 'score' DEVE SER FLOAT NUMÉRICO!
{{"status": "APROVADO", "tags": "palavra1, palavra2", "categoria": "Geopolitica", "score": 9.0}}
ou se for lixo/fake/soft news/anti-PT:
{{"status": "REPROVADO"}}
"""
    amostra = texto_bruto[:2000]
    prompt_user = f"TÍTULO: {titulo}\n\nTEXTO CAPTURADO:\n{amostra}"

    # Sprint Modelos Dinâmicos 2026-05-02 18:35 BRT — chamadas diretas
    # OpenAI/Anthropic substituídas por gerar_texto_governado(tarefa="scoring").
    # Tier "scoring" = barato (igual motor_coletor). Custo registrado automaticamente.
    prompt_user_json = prompt_user + "\n\nDEVOLVA SOMENTE JSON PURO E VÁLIDO. SEM BLOCOS MARKDOWN."
    try:
        from gsn_agente_roteador_llm import gerar_texto_governado
        resultado = gerar_texto_governado(
            "scoring",
            sys_prompt,
            prompt_user_json,
            agente_nome="robo_coleta_bruta:curadoria",
            max_tokens=200,
            temperature=0.0,
        )
        if resultado and isinstance(resultado, tuple):
            texto_resp = resultado[0]
        elif isinstance(resultado, str):
            texto_resp = resultado
        else:
            texto_resp = None

        if texto_resp:
            import re as _re
            limpo = _re.sub(r"^```json\s*", "", texto_resp.strip(), flags=_re.IGNORECASE)
            limpo = _re.sub(r"```\s*$", "", limpo).strip()
            try:
                return json.loads(limpo)
            except json.JSONDecodeError as e:
                log(f"Falha parse JSON curadoria (governado): {e} | raw: {limpo[:200]}")
    except ImportError as e:
        log(f"Roteador indisponível ({e}) — sem chamada LLM possível.")
    except Exception as e:
        log(f"Falha curadoria governada: {e}")

    return {"status": "REPROVADO"}


GLOBAL_TOPIC_SEGMENTS = [
    ("multipolar-world", ["multipolar", "global south", "south-south", "non-aligned", "dedollarization", "sanctions"]),
    ("brics", ["brics", "new development bank", "ndb", "brasil", "brazil", "china", "india", "russia", "south africa"]),
    ("development", ["development", "industrial policy", "public bank", "poverty", "food security", "health system"]),
    ("trade", ["trade", "exports", "imports", "tariff", "supply chain", "commodity", "shipping"]),
    ("infrastructure", ["railway", "rail", "port", "corridor", "logistics", "pipeline", "power plant", "highway"]),
    ("energy", ["energy", "oil", "gas", "solar", "wind", "hydro", "uranium", "electricity"]),
    ("technology", ["technology", "chips", "semiconductor", "ai", "satellite", "telecom", "digital"]),
    ("latin-america", ["latin america", "celac", "mercosur", "brazil", "argentina", "mexico", "venezuela", "colombia", "bolivia"]),
    ("africa", ["africa", "african union", "sahel", "ethiopia", "nigeria", "south africa", "kenya", "angola"]),
    ("asia", ["asia", "asean", "china", "india", "indonesia", "vietnam", "pakistan", "bangladesh"]),
    ("west-asia", ["west asia", "middle east", "iran", "iraq", "palestine", "syria", "lebanon", "yemen", "gulf"]),
]


def enriquecer_segmentacao(parecer, titulo, texto, entrada):
    """Garante tags/categoria úteis mesmo quando a IA responde genérico."""
    parecer = parecer if isinstance(parecer, dict) else {}
    base = " ".join([
        titulo or "",
        texto[:2500] if texto else "",
        entrada.get("gsn_regiao", ""),
        entrada.get("gsn_fonte_nome", ""),
    ]).lower()
    base_slug = normalize_key(base)

    categoria = str(parecer.get("categoria") or "").strip()
    if not categoria or categoria.lower() in {"global south news", "geral", "general", "politica", "política"}:
        for cat, termos in GLOBAL_TOPIC_SEGMENTS:
            if any(t in base or normalize_key(t) in base_slug for t in termos):
                categoria = cat
                break
    if not categoria:
        categoria = entrada.get("gsn_regiao", "") or "multipolar-world"

    tags = []
    tags_raw = parecer.get("tags", "")
    if isinstance(tags_raw, str):
        tags.extend(t.strip().lower() for t in tags_raw.split(",") if t.strip())
    elif isinstance(tags_raw, list):
        tags.extend(str(t).strip().lower() for t in tags_raw if str(t).strip())

    tags.append(normalize_key(categoria))
    regiao = entrada.get("gsn_regiao")
    if regiao:
        tags.append(normalize_key(regiao))
    for _, termos in GLOBAL_TOPIC_SEGMENTS:
        for termo in termos:
            if termo in base or normalize_key(termo) in base_slug:
                tags.append(normalize_key(termo))

    vistos = set()
    tags_limpas = []
    for tag in tags:
        if tag and tag not in vistos:
            vistos.add(tag)
            tags_limpas.append(tag)

    parecer["categoria"] = categoria
    parecer["cidade_detectada"] = ""
    parecer["regiao_detectada"] = entrada.get("gsn_regiao", "")
    parecer["tags"] = ", ".join(tags_limpas[:18])
    return parecer

# =============================================================================
# EXTRAÇÃO DE TEXTO DUPLA BLINDADA
# =============================================================================

def extrair_texto_oficial(url):
    if _dominio_bloqueado(url):
        return None  # Blacklist estática pra não perder tempo com paywall 100% blindado
        
    try:
        # Resolve google news link se houver
        if "news.google.com" in url:
            try:
                r = requests.head(url, allow_redirects=True, timeout=5)
                url = r.url
                if _dominio_bloqueado(url):
                    return None
            except: pass

        # Tentativa 1: Trafilatura nativo
        downloaded = trafilatura.fetch_url(url)
        if downloaded:
            texto_cru = trafilatura.extract(downloaded, include_comments=False, include_tables=False, no_fallback=False)
            if texto_cru and len(texto_cru) >= 800:
                return texto_cru

        # Tentativa 2: Bypass com cabeçalho de navegador Humano + Trafilatura Extract
        _H = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
        }
        r = requests.get(url, headers=_H, timeout=15, allow_redirects=True)
        if r.status_code == 200:
            texto_cru = trafilatura.extract(r.text, include_comments=False, include_tables=False)
            if texto_cru and len(texto_cru) >= 800:
                return texto_cru
                
    except Exception as e: pass
    return None

# =============================================================================
# GESTOR DE THREADS E SALVAMENTO
# =============================================================================

def worker_raspar_avaliar(entrada):
    titulo = entrada.title
    url = entrada.link
    
    log(f"📥 Tentando furar muro: '{titulo[:60]}...'")
    texto = extrair_texto_oficial(url)
    
    if not texto or len(texto) < 800:
        return None  # Paywall ou irrelevante
        
    # Extrai o wp_titulos_hist do dicionário de entrada, se existir
    wp_titulos_hist = entrada.get("wp_titulos_hist")
        
    # Chegou texto inteiro, manda pra juíza IA
    parecer = curadoria_llm_rapida(titulo, texto, globals().get("foco_str_global", None), wp_titulos_hist)
    parecer = enriquecer_segmentacao(parecer, titulo, texto, entrada)
    # Fact-checking preventivo (Nota de Corte = 6.5)
    score = float(parecer.get("score", 0)) if isinstance(parecer.get("score"), (int, float, str)) else 0.0
    
    status_str = str(parecer.get("status", "REPROVADO")).upper()
    if not isinstance(parecer, dict) or ("APROVAD" not in status_str):
        log(f"   🗑️ Descartada pela IA (Soft-News ou Banida): {titulo[:30]}")
        return None
        
    if score < 4.5:
        log(f"   📉 Descartada pelo Juiz de Score (Nota {score}/10): {titulo[:30]}")
        return None
        
    nome_jornal = getattr(entrada, "source", {}).get("title", "")
    if not nome_jornal:
        parts = titulo.rsplit(" - ", 1)
        if len(parts) > 1:
            nome_jornal = parts[1].strip()
            titulo = parts[0].strip()
            
    log(f"   🏅 APROVADA: {titulo[:30]} | Score: {score}/10 | Chars: {len(texto)} | Categoria: {parecer.get('categoria','Geral')}")
    
    # Injeta cabeçalho de data para consciência temporal dos redatores
    data_hoje = datetime.now(ZoneInfo("America/Sao_Paulo")).strftime("%Y-%m-%d %H:%M")
    texto_com_data = f"[DATA DE COLETA: {data_hoje}]\n\n{texto}"
    
    return {
        "titulo_original": titulo,
        "url": url,
        "fonte_jornal": nome_jornal or nome_jornal_from_url(url),
        "texto_integral": texto_com_data,
        "tags": parecer.get("tags", ""),
        "categoria_sugerida": parecer.get("categoria", "Política"),
        "regiao": entrada.get("gsn_regiao", ""),
        "cidade": parecer.get("cidade_detectada") or entrada.get("gsn_cidade", ""),
        "fonte_config": entrada.get("gsn_fonte_nome", ""),
        "tipo_fonte": entrada.get("gsn_tipo", ""),
        "tier_fonte": entrada.get("gsn_tier", ""),
        "data_coleta": datetime.now().isoformat(),
        "score": score,
        "processado_v9": False
    }

def iniciar_varredura(dry_run=False, regiao=None):
    wp_titulos_hist = load_historico_titulos()
    banco_atual = load_banco_bruto()
    
    # Avaliar flag Trends
    global foco_str_global
    foco_str_global = None
    import sys
    import urllib.parse
    feeds = []
    
    if "--trends" in sys.argv:
        try:
            with open(os.path.join(AGENT_DATA_DIR, "foco_pauta.json"), "r", encoding="utf-8") as fd:
                foco_d = json.load(fd)
                foco_str_global = foco_d.get("foco_str", "")
                if foco_str_global:
                    q = urllib.parse.quote(foco_str_global)
                    feeds.append({"nome": f"Google News Trends: {foco_str_global}", "url": f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"})
                    log(f"🔥 MODO CAÇADOR TRENDS ATIVADO: Buscando ativamente por [{foco_str_global}]")
        except: pass

    if not feeds:
        feeds = carregar_fontes_regionais(regiao=regiao)
        if feeds:
            foco_str_global = construir_foco_hiperlocal(regiao=regiao)

    if not feeds:
        feeds = [
            {"nome": "Al Jazeera (Inglês)", "url": "https://www.aljazeera.com/xml/rss/all.xml"},
            {"nome": "Sputnik International", "url": "https://sputnikglobe.com/export/rss2/archive/index.xml"},
            {"nome": "RT News (Inglês)", "url": "https://www.rt.com/rss/"},
            {"nome": "Global Times (China)", "url": "https://www.globaltimes.cn/rss/rss.xml"},
            {"nome": "CGTN (China Inglês)", "url": "https://www.cgtn.com/rss/world.xml"},
            {"nome": "Xinhua (Chinês)", "url": "http://www.news.cn/world/index.xml"},
            
            # Espanhol / América Latina
            {"nome": "TeleSUR (Espanhol)", "url": "https://www.telesurtv.net/rss/index.xml"},
            {"nome": "Prensa Latina", "url": "https://www.prensa-latina.cu/feed/"},
            {"nome": "RT en Español", "url": "https://actualidad.rt.com/rss"},
            
            # Oriente Médio / Árabe / Iraniano
            {"nome": "Al Mayadeen (Árabe)", "url": "https://www.almayadeen.net/rss"},
            {"nome": "IRNA (Inglês)", "url": "https://en.irna.ir/rss"},
            {"nome": "IRNA (Árabe)", "url": "https://ar.irna.ir/rss"},
            {"nome": "Press TV (Irã)", "url": "https://www.presstv.ir/rss"},
            
            # Europa / fontes multilaterais
            {"nome": "France24 (Francês)", "url": "https://www.france24.com/fr/rss"},
            {"nome": "RFI Français", "url": "https://www.rfi.fr/fr/rss"},
            {"nome": "Tagesschau (Alemão)", "url": "https://www.tagesschau.de/xml/rss2/"},
            {"nome": "ANSA (Italiano)", "url": "https://www.ansa.it/sito/ansait_rss.xml"},
            {"nome": "AMNA (Grego)", "url": "https://www.amna.gr/rss/general"}
        ]
        random.shuffle(feeds)
    
    # Coletar e juntar todas as entries
    todas_entradas = []
    for escolha in feeds:
        try:
            if _fonte_nome_bloqueada(escolha.get("nome", "")) or _dominio_bloqueado(escolha.get("url", "")):
                log(f"Fonte bloqueada por regra editorial: {escolha.get('nome', '')} ({escolha.get('url', '')})")
                continue
            feed = feedparser.parse(escolha['url'])
            if feed.entries:
                for entrada in feed.entries[:12]: # Pega os 12 mais quentes de cada
                    entrada["gsn_fonte_nome"] = escolha.get("nome", "")
                    entrada["gsn_regiao"] = escolha.get("regiao", "")
                    entrada["gsn_cidade"] = escolha.get("cidade", "")
                    entrada["gsn_tipo"] = escolha.get("tipo", "")
                    entrada["gsn_tier"] = escolha.get("tier", "")
                    todas_entradas.append(entrada)
        except Exception as e: log(f"Falha lendo XML {escolha['nome']}: {e}")

    # Remove URLs duplicatas brutas
    vistas = set()
    entradas_limpas = []
    for e in todas_entradas:
        if e.link not in vistas:
            vistas.add(e.link)
            entradas_limpas.append(e)

    # Remove duplicates via Jaccard antes do MultiThread pra impedir colisões ao vivo
    entradas_jaccard = []
    memoria_banco_temp = banco_atual.copy()
    for e in entradas_limpas:
        if not eh_duplicata(e.title, wp_titulos_hist, memoria_banco_temp):
            # Passa wp_titulos_hist para a entrada para poder usar no LLM
            e["wp_titulos_hist"] = wp_titulos_hist
            entradas_jaccard.append(e)
            memoria_banco_temp.append({"titulo_original": e.title})
            
    log(f"Iniciando raspagem e avaliação de {len(entradas_jaccard)} matérias INÉDITAS (Threadpool = 4)...")
    artigos_aprovados = []
    
    # Paralelismo! 4 browsers navegando simultaneamente na deepweb
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(worker_raspar_avaliar, ent) for ent in entradas_jaccard]
        for future in as_completed(futures):
            resultado = future.result()
            if resultado:
                artigos_aprovados.append(resultado)
                # Mantem atualizado a lista para Jaccard em tempo real não pegar colisão
                
    if artigos_aprovados:
        log(f"Salvas {len(artigos_aprovados)} matérias brutais no JSON do Agente V9.")
        try:
            from gsn_inbox import salvar_artigos
            qtd = salvar_artigos(artigos_aprovados)
            log(f"gsn_inbox.db atualizado com {qtd} pauta(s) segmentada(s).")
        except Exception as e:
            log(f"Falha salvando no gsn_inbox.db (JSON preservado): {e}")
        banco_completo = banco_atual + artigos_aprovados
        
        # Limpar lixo velho pra não estourar HD
        if len(banco_completo) > 70:
            banco_nao_processados = [a for a in banco_completo if not a.get("processado_v9", False)]
            if len(banco_nao_processados) < 30:
                banco_completo = banco_nao_processados + banco_completo[-30:] 
            else:
                banco_completo = banco_completo[-70:]
                
        if not dry_run:
            _save_banco_locked(BANCO_JSON, banco_completo)
        else:
            log("DRY-RUN: O banco de artigos brutos NÃO foi modificado.")
    else:
        log("Varredura completada. Nenhuma pauta de peso passou pelo filtro impiedoso.")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Coletor Bruto de Notícias - Global South News")
    parser.add_argument("--run", action="store_true", help="Executa a coleta de fato.")
    parser.add_argument("--dry-run", action="store_true", help="Simula a execução sem salvar no banco.")
    parser.add_argument("--trends", action="store_true", help="Ativa modo caçador de trends.")
    parser.add_argument("--regiao", help="Filtra fontes regionais por regiao/cidade/tipo do config gsn_fontes_regionais.json.")
    args, unknown = parser.parse_known_args()

    if not args.run and not args.dry_run:
        print("⚠️ Modo de segurança ativado. O coletor não fará nada.")
        print("Use --run para executar de verdade ou --dry-run para simular.")
        parser.print_help()
        sys.exit(0)

    log("Iniciando rotina V2 de coleta com Arquitetura Master.")
    iniciar_varredura(dry_run=args.dry_run, regiao=args.regiao)
    log("Ciclo de coleta finalizado.")
