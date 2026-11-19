export const SPREADSHEET_ID = '1GsN74WrnAnXOVKx6ltlmKUCFrtGYh4P6cztk_2pbBjA';
const NOME_ABA_DADOS_BRUTOS = 'Coleta de dados demanda';
const NOME_ABA_CADASTRO = 'Informações de demanda';

export interface UsinaCadastroInfo {
  usina: string;
  contractedDemandKw: number;
  toleranceLimitKw: number;
  threshold5PctKw: number;
}

export interface UsinaDemandaItem {
  usina: string;
  ano: number;
  meses: { [mes: string]: number };
  detalhesPico: { [mes: string]: { dia: string; hora: string } };
}

export interface DemandaAnoData {
  ano: number;
  dados: UsinaDemandaItem[];
}

export interface DadosCompletosSheets {
  anos: DemandaAnoData[];
  cadastro: { [chaveNormalizada: string]: UsinaCadastroInfo };
}

// Normaliza nomes para cruzar perfeitamente (ex: "Iraí de Minas I" == "Irai de Minas I", "Salto de Pirapora - UFV 4" == "Salto de Pirapora (UFV 4)")
export function normalizarChaveUsina(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove acentos
    .replace(/[-()]/g, ' ') // Troca hífens e parênteses por espaço
    .replace(/\s+/g, ' ') // Remove espaços duplos
    .trim()
    .toLowerCase();
}

function parseNumeroPlanilha(valStr: string | undefined): number {
  if (!valStr) return 0;
  let limpo = valStr.trim();
  if (limpo.includes(',') && limpo.includes('.')) {
    limpo = limpo.replace(/\./g, '').replace(',', '.');
  } else if (limpo.includes(',')) {
    limpo = limpo.replace(',', '.');
  }
  return parseFloat(limpo) || 0;
}

function parseCsvLinhas(text: string): string[][] {
  const lines: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let insideQuote = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"') {
      if (insideQuote && next === '"') {
        cur += '"';
        i++;
      } else {
        insideQuote = !insideQuote;
      }
    } else if (c === ',' && !insideQuote) {
      row.push(cur.trim());
      cur = '';
    } else if ((c === '\r' || c === '\n') && !insideQuote) {
      if (c === '\r' && next === '\n') i++;
      row.push(cur.trim());
      if (row.some((cell) => cell.length > 0)) lines.push(row);
      row = [];
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur.trim());
    if (row.some((cell) => cell.length > 0)) lines.push(row);
  }
  return lines;
}

function parseDataSegura(str: string): { dia: string; mesIdx: number; ano: number } | null {
  if (!str || str === 'N/A') return null;
  const apenasData = str.split(' ')[0].trim();

  if (apenasData.includes('/')) {
    const partes = apenasData.split('/');
    if (partes.length === 3) {
      const p0 = parseInt(partes[0], 10);
      const p1 = parseInt(partes[1], 10);
      const ano = parseInt(partes[2], 10);

      if (p1 > 12) {
        return {
          dia: `${String(p1).padStart(2, '0')}/${String(p0).padStart(2, '0')}/${ano}`,
          mesIdx: p0 - 1,
          ano,
        };
      }

      return {
        dia: `${String(p0).padStart(2, '0')}/${String(p1).padStart(2, '0')}/${ano}`,
        mesIdx: p1 - 1,
        ano,
      };
    }
  }

  if (apenasData.includes('-')) {
    const partes = apenasData.split('-');
    if (partes.length === 3) {
      const ano = parseInt(partes[0], 10);
      const mes = parseInt(partes[1], 10);
      const dia = parseInt(partes[2], 10);
      return {
        dia: `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${ano}`,
        mesIdx: mes - 1,
        ano,
      };
    }
  }

  return null;
}

async function carregarCadastroDemandas(spreadsheetId: string): Promise<{ [chave: string]: UsinaCadastroInfo }> {
  const nomeAba = encodeURIComponent(NOME_ABA_CADASTRO);
  const tq = encodeURIComponent('SELECT A, B, C');
 const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=0&sheet=${nomeAba}`;

  const mapa: { [chave: string]: UsinaCadastroInfo } = {};

  try {
    const res = await fetch(url);
    if (!res.ok) return mapa;

    const csvText = await res.text();
    if (csvText.includes('<!DOCTYPE html>')) return mapa;

    const rows = parseCsvLinhas(csvText);
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r[0]) continue;

      const usinaNome = r[0]
        .replace(/^Solar Field\s*/i, '')
        .replace(/:\s*Active Power$/i, '')
        .trim();

      const contratada = parseNumeroPlanilha(r[1]);
      let limite = parseNumeroPlanilha(r[2]);

      if (contratada <= 0) continue;
      if (limite <= 0) limite = Number((contratada * 1.03).toFixed(2));

      const chave = normalizarChaveUsina(usinaNome);
      mapa[chave] = {
        usina: usinaNome,
        contractedDemandKw: contratada,
        toleranceLimitKw: limite,
        threshold5PctKw: Number((contratada * 0.95).toFixed(2)),
      };
    }
  } catch (err) {
    console.warn('Aviso ao ler aba Informações de demanda:', err);
  }

  return mapa;
}


export async function carregarTodosOsAnosDinamicos(spreadsheetId = SPREADSHEET_ID): Promise<DemandaAnoData[]> {
  const res = await carregarDadosCompletosSheets(spreadsheetId);
  return res.anos;
}
const CACHE_KEY = 'cache_demanda_usinas_v2';

export function limparCacheSheets() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch (e) {
    // Ignora erro se storage estiver bloqueado
  }
}

export async function carregarDadosCompletosSheets(
  spreadsheetId = SPREADSHEET_ID,
  forcarAtualizacao = false
): Promise<DadosCompletosSheets> {
  // 1. Se não for atualização forçada, tenta devolver o cache em menos de 50ms
  if (!forcarAtualizacao) {
    try {
      const salvo = localStorage.getItem(CACHE_KEY);
      if (salvo) {
        const parsed = JSON.parse(salvo);
        // Cache válido por 15 minutos (900.000 ms)
        if (parsed && parsed.timestamp && Date.now() - parsed.timestamp < 900000 && parsed.dados?.anos?.length > 0) {
          return parsed.dados;
        }
      }
    } catch (e) {
      // Se falhar leitura do cache, segue para busca online
    }
  }

  const nomeAba = encodeURIComponent(NOME_ABA_DADOS_BRUTOS);
  // Filtra linhas vazias direto no Google Sheets (WHERE B IS NOT NULL) para reduzir o tamanho do download
  const tq = encodeURIComponent('SELECT A, B, C, D WHERE B IS NOT NULL');
const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${nomeAba}&t=${Date.now()}`;

  const [resColeta, cadastro] = await Promise.all([
    fetch(url),
    carregarCadastroDemandas(spreadsheetId),
  ]);

  if (!resColeta.ok) return { anos: [], cadastro };

  const csvText = await resColeta.text();
  if (csvText.includes('<!DOCTYPE html>')) return { anos: [], cadastro };

  const rows = parseCsvLinhas(csvText);
  if (rows.length < 2) return { anos: [], cadastro };

  const mesesNomes = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const agrupamentoPorAno = new Map<number, Map<string, UsinaDemandaItem>>();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0] || !r[1]) continue;

    const infoColA = parseDataSegura(r[0].trim());
    if (!infoColA) continue;

    const { dia: diaColA, mesIdx, ano } = infoColA;
    if (isNaN(ano) || isNaN(mesIdx) || mesIdx < 0 || mesIdx > 11) continue;

    const usina = r[1]
      .trim()
      .replace(/^Solar Field\s*/i, '')
      .replace(/:\s*Active Power$/i, '')
      .trim();

    const potencia = parseNumeroPlanilha(r[2]);
    const colD = r[3] ? r[3].trim() : '';
    let diaFinal = diaColA;
    let horaFinal = '--:--';

    if (colD && colD !== 'N/A') {
      if (colD.includes(' ')) {
        const partes = colD.split(' ');
        const dataRealD = parseDataSegura(partes[0]);
        diaFinal = dataRealD ? dataRealD.dia : partes[0];
        horaFinal = partes[1] || '--:--';
      } else if (colD.includes(':')) {
        diaFinal = diaColA;
        horaFinal = colD;
      }
    }

    const mesNome = mesesNomes[mesIdx];

    if (!agrupamentoPorAno.has(ano)) {
      agrupamentoPorAno.set(ano, new Map());
    }
    const usinasDoAno = agrupamentoPorAno.get(ano)!;

    if (!usinasDoAno.has(usina)) {
      usinasDoAno.set(usina, {
        usina,
        ano,
        meses: {},
        detalhesPico: {},
      });
    }

    const usinaData = usinasDoAno.get(usina)!;
    const picoAtualNoMes = usinaData.meses[mesNome] || 0;

    if (potencia > picoAtualNoMes) {
      usinaData.meses[mesNome] = potencia;
      usinaData.detalhesPico[mesNome] = { dia: diaFinal, hora: horaFinal };
    }
  }

  const anos: DemandaAnoData[] = [];
  agrupamentoPorAno.forEach((usinasMap, ano) => {
    anos.push({
      ano,
      dados: Array.from(usinasMap.values()),
    });
  });

  const resultadoFinal: DadosCompletosSheets = {
    anos: anos.sort((a, b) => b.ano - a.ano),
    cadastro,
  };

  // Salva o resultado no navegador para próximas aberturas instantâneas
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        timestamp: Date.now(),
        dados: resultadoFinal,
      })
    );
  } catch (e) {
    // Ignora se estourar limite de storage
  }

  return resultadoFinal;
}