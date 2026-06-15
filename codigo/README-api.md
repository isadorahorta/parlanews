# ParlaNews — Documentação da Camada de APIs

## Visão geral

O ParlaNews consome quatro APIs para recuperar dados parlamentares e notícias em tempo real:

| Fonte | Tipo | Chave | CORS no navegador |
|---|---|---|---|
| Câmara dos Deputados | Dados parlamentares | Não precisa | ✅ Liberado |
| Senado Federal | Dados parlamentares | Não precisa | ⚠️ Pode falhar |
| GNews | Notícias | Obrigatória | ✅ Funciona |
| NewsAPI | Notícias | Obrigatória | ❌ Bloqueado no plano free |

## Arquivos

- **`api.js`** — módulo que implementa o pipeline completo: Coleta → Limpeza → Normalização → Indexação temática → Recuperação. Exporta `ParlaNewsAPI`.
- **`index.html`** — interface principal. Sempre consome as APIs reais ao pesquisar. Usa dados simulados como fallback se as APIs de notícias não retornarem resultados.

## Como rodar

Abra um servidor local na pasta `codigo/` (o `fetch` não funciona com `file://`):

```bash
python3 -m http.server 8000
```

Acesse `http://localhost:8000/index.html` e pesquise qualquer parlamentar.

## Configuração das chaves (api.js)

As chaves ficam nas primeiras linhas do `api.js`, dentro de `CONFIG`:

```js
const CONFIG = {
  GNEWS_APIKEY: '85bb2ba5765a80a606f1c306b0595ac9',  // gnews.io
  NEWSAPI_KEY:  '240d1d219a984e389fb0a4a138f8ea2e',  // newsapi.org
  PROXY_CORS:   '',   // opcional — ver seção CORS abaixo
  ...
};
```

## Como pesquisar

Digite o nome de qualquer parlamentar no campo de busca. Suporta operadores booleanos:

| Operador | Exemplo | Comportamento |
|---|---|---|
| Simples | `Erika Hilton` | Retorna tudo que contém o nome |
| AND | `Erika Hilton AND educação` | Retorna apenas resultados com ambos os termos |
| OR | `Erika Hilton OR saúde` | Retorna resultados com qualquer um dos termos |
| NOT | `Erika Hilton NOT economia` | Exclui resultados que contenham o segundo termo |

## Uso direto do módulo

```js
const { parlamentar, resultados } =
  await ParlaNewsAPI.carregarNoticias('Erika Hilton AND educação', { ordenacao: 'recente' });
```

Cada item de `resultados` tem o formato:

```js
{
  parlamentar, cargo, partido, estado,  // dados da Câmara ou Senado
  tema, fonte, data, relevancia,         // metadados e indexação temática
  titulo, resumo, url                    // conteúdo da notícia
}
```

## Pipeline de dados (item 5.1)

```
Coleta        → fetchJSON()              — requisição HTTP com timeout e tratamento de erro
Limpeza       → normalizarNome()         — padroniza capitalização ("ERIKA HILTON" → "Erika Hilton")
              → paraDataISO()            — converte qualquer formato de data para YYYY-MM-DD
              → removerDuplicadas()      — remove notícias repetidas por URL ou título
Normalização  → normalizarTexto()        — remove acentos, converte para minúsculas
Indexação     → classificarTema()        — classifica automaticamente em Educação, Saúde, Economia etc.
Recuperação   → carregarNoticias()       — orquestra tudo e une perfil parlamentar + notícias
```

## Indexação temática (item 3.2)

A função `classificarTema()` aplica uma taxonomia de palavras-chave ao título e resumo de cada notícia:

| Tema | Exemplos de palavras-chave |
|---|---|
| Educação | escola, ensino, universidade, professor |
| Saúde | hospital, SUS, vacina, paciente |
| Economia | orçamento, imposto, PIB, inflação |
| Meio Ambiente | clima, desmatamento, Amazônia |
| Segurança Pública | polícia, crime, violência |
| Direitos Humanos | cidadania, igualdade, social |
| Tecnologia | dados, digital, inteligência artificial |

## Observações sobre CORS e chaves

- **Câmara dos Deputados**: API pública, CORS liberado, funciona diretamente no navegador.
- **Senado Federal**: API pública, mas nem sempre envia cabeçalhos CORS. Se falhar, configure `CONFIG.PROXY_CORS` (ex.: `https://corsproxy.io/?url=`).
- **GNews**: aceita operadores AND/OR/NOT no parâmetro `q`. A chave fica visível no front-end — aceitável para protótipo acadêmico, não para produção.
- **NewsAPI**: o plano gratuito bloqueia chamadas diretas do navegador (CORS). Para ativá-la, use um backend próprio ou um proxy e configure `CONFIG.PROXY_CORS`.

Em produção, o ideal é mover todas as chamadas para um backend (Node.js, Python etc.) e guardar as chaves no servidor. O `api.js` já exporta via `module.exports` para facilitar esse reaproveitamento.

## Relação com os itens do trabalho

| Item | Como é atendido |
|---|---|
| 3.2 — Indexação temática | Taxonomia em `TAXONOMIA` + `classificarTema()` |
| 4.1 — Recuperação da informação | Busca simples, filtros, operadores booleanos e ordenação na interface |
| 5.1 — Pipeline de dados | `fetchJSON` → normalização → indexação → `carregarNoticias()` |
| 5.2 — Modelo ER | `carregarNoticias()` materializa o relacionamento Parlamentar ↔ Notícia ↔ Tema |
