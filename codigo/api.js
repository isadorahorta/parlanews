/* =============================================================================
   ParlaNews - Camada de consumo de APIs (Etapa 2 / item 5.1 - Pipeline)
   -----------------------------------------------------------------------------
   Responsavel por: Coleta -> Limpeza -> Normalizacao -> Indexacao tematica.
   Fontes:
     - API de Dados Abertos da Camara dos Deputados (publica, sem chave, CORS ok)
     - API de Dados Abertos do Senado Federal       (publica, sem chave)
     - GNews                                          (requer chave gratuita)
     - NewsAPI                                        (requer chave; ver nota CORS)

   Saida: objetos no MESMO formato que a interface (index.html) ja consome:
     { parlamentar, cargo, partido, estado, tema, fonte, data, relevancia,
       titulo, resumo, url }

   Uso:
     <script src="api.js"></script>
     const dados = await ParlaNewsAPI.carregarNoticias('Erika Hilton AND educacao');
   ========================================================================== */

const ParlaNewsAPI = (() => {
  'use strict';

  /* ---------------------------------------------------------------------------
     1. CONFIGURACAO
     - Coloque suas chaves aqui. As das APIs governamentais nao precisam de chave.
     - PROXY_CORS: o Senado e a NewsAPI nem sempre liberam CORS para o navegador.
       Em producao o ideal e um backend proprio; para teste pode-se usar um proxy.
       Deixe '' para chamar direto.
  --------------------------------------------------------------------------- */
  const CONFIG = {
    GNEWS_APIKEY:  (typeof window !== 'undefined' && window.ParlaNewsConfig?.GNEWS_APIKEY) || '',
    NEWSAPI_KEY:   (typeof window !== 'undefined' && window.ParlaNewsConfig?.NEWSAPI_KEY)  || '',
    PROXY_CORS:    '',   // ex.: 'https://corsproxy.io/?url='  (opcional)
    IDIOMA:        'pt',
    PAIS:          'br',
    MAX_NOTICIAS:  10,
    TIMEOUT_MS:    8000
  };

  /* ---------------------------------------------------------------------------
     2. UTILITARIOS DE REDE E NORMALIZACAO (etapa de Limpeza/Normalizacao)
  --------------------------------------------------------------------------- */

  // fetch com timeout e tratamento de erro
  async function fetchJSON(url, headers = {}) {
    const alvo = CONFIG.PROXY_CORS ? CONFIG.PROXY_CORS + encodeURIComponent(url) : url;
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), CONFIG.TIMEOUT_MS);
    try {
      const resp = await fetch(alvo, { headers, signal: ctrl.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} em ${url}`);
      return await resp.json();
    } finally {
      clearTimeout(id);
    }
  }

  // remove acentos e baixa caixa (mesma logica da interface)
  function normalizarTexto(t) {
    return (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  // padroniza nomes proprios: "ERIKA HILTON" -> "Erika Hilton"
  function normalizarNome(nome) {
    return (nome || '')
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .map(p => p.length <= 2 ? p : p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
  }

  // converte qualquer formato de data para o padrao unico YYYY-MM-DD
  function paraDataISO(valor) {
    if (!valor) return '';
    const m = String(valor).match(/^\d{4}-\d{2}-\d{2}/);
    if (m) return m[0];
    const d = new Date(valor);
    return isNaN(d) ? '' : d.toISOString().slice(0, 10);
  }

  // remove registros duplicados por URL (ou titulo, quando nao ha URL)
  function removerDuplicadas(noticias) {
    const vistos = new Set();
    return noticias.filter(n => {
      const chave = normalizarTexto(n.url || n.titulo);
      if (vistos.has(chave)) return false;
      vistos.add(chave);
      return true;
    });
  }

  /* ---------------------------------------------------------------------------
     3. INDEXACAO TEMATICA (taxonomia simplificada - item 3.2)
        Classifica automaticamente a noticia em uma categoria com base em
        palavras-chave presentes no titulo + resumo.
  --------------------------------------------------------------------------- */
  const TAXONOMIA = {
    'Educacao':           ['educacao', 'escola', 'ensino', 'universidade', 'estudante', 'aluno', 'professor'],
    'Saude':              ['saude', 'hospital', 'sus', 'vacina', 'medic', 'doenca', 'paciente'],
    'Economia':           ['economia', 'orcamento', 'imposto', 'tributo', 'pib', 'inflacao', 'fiscal', 'salario'],
    'Meio Ambiente':      ['ambiente', 'clima', 'desmatamento', 'amazonia', 'sustentab', 'poluicao'],
    'Seguranca Publica':  ['seguranca', 'policia', 'crime', 'violencia', 'armas'],
    'Direitos Humanos':   ['direitos humanos', 'cidadania', 'igualdade', 'minoria', 'social', 'lgbt'],
    'Tecnologia':         ['tecnologia', 'dados', 'digital', 'internet', 'inteligencia artificial', 'inovacao']
  };

  function classificarTema(titulo, resumo) {
    const texto = normalizarTexto(`${titulo} ${resumo}`);
    let melhor = { tema: 'Geral', score: 0 };
    for (const [tema, termos] of Object.entries(TAXONOMIA)) {
      const score = termos.reduce((s, t) => s + (texto.includes(t) ? 1 : 0), 0);
      if (score > melhor.score) melhor = { tema, score };
    }
    return melhor.tema;
  }

  // relevancia heuristica (0-100): cobertura dos termos + recencia
  function calcularRelevancia(titulo, resumo, consulta, dataISO) {
    const texto = normalizarTexto(`${titulo} ${resumo}`);
    const termos = normalizarTexto(consulta)
      .replace(/\b(and|or|not)\b/g, ' ')
      .split(/\s+/).filter(t => t.length > 2);
    const cobertura = termos.length
      ? termos.filter(t => texto.includes(t)).length / termos.length
      : 0.5;
    const dias = dataISO ? (Date.now() - new Date(dataISO)) / 86400000 : 365;
    const recencia = Math.max(0, 1 - dias / 365);          // decai ao longo de 1 ano
    return Math.round((0.7 * cobertura + 0.3 * recencia) * 100);
  }

  // extrai o nome do parlamentar de uma consulta com operadores booleanos
  // ex.: "Erika Hilton AND educacao" -> "Erika Hilton"
  function extrairNomeParlamentar(consulta) {
    return (consulta || '').split(/\s+(AND|OR|NOT)\s+/i)[0].trim();
  }

  /* ---------------------------------------------------------------------------
     4. FONTES GOVERNAMENTAIS -> dados do parlamentar
  --------------------------------------------------------------------------- */

  // Camara dos Deputados (CORS liberado, sem autenticacao)
  async function buscarDeputados(nome) {
    const url = `https://dadosabertos.camara.leg.br/api/v2/deputados`
      + `?nome=${encodeURIComponent(nome)}&ordem=ASC&ordenarPor=nome`;
    try {
      const json = await fetchJSON(url, { Accept: 'application/json' });
      return (json.dados || []).map(d => ({
        nome:    normalizarNome(d.nome),
        cargo:   'Deputado(a) Federal',
        partido: d.siglaPartido || '',
        estado:  d.siglaUf || '',
        urlFoto: d.urlFoto || '',
        email:   d.email || '',
        fonteDados: 'Camara dos Deputados'
      }));
    } catch (e) {
      console.warn('[Camara] falha:', e.message);
      return [];
    }
  }

  // Senado Federal. A API retorna a lista de TODOS os senadores em exercicio;
  // o filtro por nome e feito localmente (a etapa de limpeza/normalizacao).
  async function buscarSenadores(nome) {
    const url = `https://legis.senado.leg.br/dadosabertos/senador/lista/atual`;
    try {
      const json = await fetchJSON(url, { Accept: 'application/json' });
      const lista = json?.ListaParlamentarEmExercicio?.Parlamentares?.Parlamentar || [];
      const alvo = normalizarTexto(nome);
      return lista
        .map(p => p.IdentificacaoParlamentar || {})
        .filter(p => normalizarTexto(p.NomeParlamentar).includes(alvo))
        .map(p => ({
          nome:    normalizarNome(p.NomeParlamentar),
          cargo:   'Senador(a)',
          partido: p.SiglaPartidoParlamentar || '',
          estado:  p.UfParlamentar || '',
          urlFoto: p.UrlFotoParlamentar || '',
          email:   p.EmailParlamentar || '',
          fonteDados: 'Senado Federal'
        }));
    } catch (e) {
      // O Senado nem sempre envia cabecalhos CORS. Se falhar, configure CONFIG.PROXY_CORS.
      console.warn('[Senado] falha (possivel CORS, ver CONFIG.PROXY_CORS):', e.message);
      return [];
    }
  }

  // unifica as duas fontes governamentais
  async function buscarParlamentares(nome) {
    const [deps, sens] = await Promise.all([buscarDeputados(nome), buscarSenadores(nome)]);
    return [...deps, ...sens];
  }

  /* ---------------------------------------------------------------------------
     5. FONTES JORNALISTICAS -> noticias
  --------------------------------------------------------------------------- */

  // GNews v4 (aceita operadores booleanos AND/OR/NOT diretamente no parametro q)
  async function buscarNoticiasGNews(consulta, { sortby = 'publishedAt' } = {}) {
    if (!CONFIG.GNEWS_APIKEY) { console.info('[GNews] sem chave (CONFIG.GNEWS_APIKEY).'); return []; }
    const url = `https://gnews.io/api/v4/search`
      + `?q=${encodeURIComponent(consulta)}`
      + `&lang=${CONFIG.IDIOMA}&country=${CONFIG.PAIS}`
      + `&max=${CONFIG.MAX_NOTICIAS}&sortby=${sortby}`
      + `&apikey=${CONFIG.GNEWS_APIKEY}`;
    try {
      const json = await fetchJSON(url);
      return (json.articles || []).map(a => ({
        titulo: a.title,
        resumo: a.description || '',
        data:   paraDataISO(a.publishedAt),
        fonte:  a.source?.name || 'GNews',
        url:    a.url
      }));
    } catch (e) {
      console.warn('[GNews] falha:', e.message);
      return [];
    }
  }

  // NewsAPI (everything). ATENCAO: o plano gratuito bloqueia chamadas do
  // navegador por CORS - so funciona via backend/proxy. Mantido como fonte extra.
  async function buscarNoticiasNewsAPI(consulta, { sortBy = 'publishedAt' } = {}) {
    if (!CONFIG.NEWSAPI_KEY) { console.info('[NewsAPI] sem chave (CONFIG.NEWSAPI_KEY).'); return []; }
    const url = `https://newsapi.org/v2/everything`
      + `?q=${encodeURIComponent(consulta)}`
      + `&language=${CONFIG.IDIOMA}&sortBy=${sortBy}&pageSize=${CONFIG.MAX_NOTICIAS}`
      + `&apiKey=${CONFIG.NEWSAPI_KEY}`;
    try {
      const json = await fetchJSON(url);
      return (json.articles || []).map(a => ({
        titulo: a.title,
        resumo: a.description || '',
        data:   paraDataISO(a.publishedAt),
        fonte:  a.source?.name || 'NewsAPI',
        url:    a.url
      }));
    } catch (e) {
      console.warn('[NewsAPI] falha (provavel CORS no plano gratuito):', e.message);
      return [];
    }
  }

  // agrega as fontes jornalisticas (GNews primeiro; NewsAPI como complemento)
  async function buscarNoticias(consulta, opts = {}) {
    const sortby = opts.ordenacao === 'relevancia' ? 'relevance' : 'publishedAt';
    const [g, n] = await Promise.all([
      buscarNoticiasGNews(consulta, { sortby }),
      buscarNoticiasNewsAPI(consulta, { sortBy: sortby })
    ]);
    return removerDuplicadas([...g, ...n]);
  }

  /* ---------------------------------------------------------------------------
     6. ORQUESTRACAO (associacao parlamentar <-> noticias, item 3.1/5.1)
        Junta tudo no formato esperado pela interface.
  --------------------------------------------------------------------------- */
  async function carregarNoticias(consulta, opts = {}) {
    const nome = extrairNomeParlamentar(consulta);

    const [parlamentares, noticias] = await Promise.all([
      buscarParlamentares(nome),
      buscarNoticias(consulta, opts)
    ]);

    const principal = parlamentares[0] || {
      nome: normalizarNome(nome), cargo: '', partido: '', estado: ''
    };

    const resultados = noticias.map(n => ({
      parlamentar: principal.nome,
      cargo:       principal.cargo,
      partido:     principal.partido,
      estado:      principal.estado,
      tema:        classificarTema(n.titulo, n.resumo),
      fonte:       n.fonte,
      data:        n.data,
      relevancia:  calcularRelevancia(n.titulo, n.resumo, consulta, n.data),
      titulo:      n.titulo,
      resumo:      n.resumo,
      url:         n.url
    }));

    // ordenacao final por data (mais recente primeiro) como padrao
    resultados.sort((a, b) => new Date(b.data) - new Date(a.data));
    return { parlamentar: principal, resultados };
  }

  /* ---------------------------------------------------------------------------
     7. API publica do modulo
  --------------------------------------------------------------------------- */
  return {
    CONFIG,
    // alto nivel
    carregarNoticias,
    // fontes
    buscarParlamentares, buscarDeputados, buscarSenadores,
    buscarNoticias, buscarNoticiasGNews, buscarNoticiasNewsAPI,
    // utilitarios (reaproveitaveis e testaveis)
    normalizarTexto, normalizarNome, paraDataISO, removerDuplicadas,
    classificarTema, calcularRelevancia, extrairNomeParlamentar
  };
})();

// permite uso tambem como modulo (Node/testes), sem quebrar o uso via <script>
if (typeof module !== 'undefined' && module.exports) module.exports = ParlaNewsAPI;
