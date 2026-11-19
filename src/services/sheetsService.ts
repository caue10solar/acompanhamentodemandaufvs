export const SPREADSHEET_ID = '1GsN74WrnAnXOVKx6ltlmKUCFrtGYh4P6cztk_2pbBjA';
const NOME_ABA_DADOS_BRUTOS = 'Coleta de dados demanda';

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

function parseDataColunaA(str: string): { dia: string; mesIdx: number; ano: number } | null {
  if (!str) return null;
  const apenasData = str.split(' ')[0].trim();

  if (apenasData.includes('/')) {
    const partes = apenasData.split('/');
    if (partes.length === 3) {
      const p0 = parseInt(partes[0], 10);
      const p1 = parseInt(partes[1], 10);
      const ano = parseInt(partes[2], 10);

      // Se p1 > 12, o Google enviou formato americano MM/DD/YYYY (ex: 11/19/2026 -> Mês 11, Dia 19)
      if (p1 > 12) {
        return {
          dia: `${String(p1).padStart(2, '0')}/${String(p0).padStart(2, '0')}/${ano}`,
          mesIdx: p0 - 1,
          ano,
        };
      }

      // Padrão brasileiro DD/MM/YYYY (ex: 01/11/2026 -> Dia 01, Mês 11)
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

export async function carregarTodosOsAnosDinamicos(spreadsheetId = SPREADSHEET_ID): Promise<DemandaAnoData[]> {
  const nomeAba = encodeURIComponent(NOME_ABA_DADOS_BRUTOS);
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${nomeAba}&headers=1&t=${Date.now()}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return [];

    const csvText = await res.text();
    if (csvText.includes('<!DOCTYPE html>')) return [];

    const rows = parseCsvLinhas(csvText);
    if (rows.length < 2) return [];

    const mesesNomes = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const agrupamentoPorAno = new Map<number, Map<string, UsinaDemandaItem>>();

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r[0] || !r[1]) continue;

      const dataColA = r[0].trim();
      const infoData = parseDataColunaA(dataColA);
      if (!infoData) continue;

      const { dia: diaColA, mesIdx, ano } = infoData;
      if (isNaN(ano) || isNaN(mesIdx) || mesIdx < 0 || mesIdx > 11) continue;

      const usinaBruta = r[1].trim();
      const usina = usinaBruta
        .replace(/^Solar Field\s*/i, '')
        .replace(/:\s*Active Power$/i, '')
        .trim();

      let potenciaStr = r[2] ? r[2].trim() : '0';
      if (potenciaStr.includes(',') && potenciaStr.includes('.')) {
        potenciaStr = potenciaStr.replace(/\./g, '').replace(',', '.');
      } else if (potenciaStr.includes(',')) {
        potenciaStr = potenciaStr.replace(',', '.');
      }
      const potencia = parseFloat(potenciaStr) || 0;

      const horaColD = r[3] ? r[3].trim() : '';
      let diaFinal = diaColA;
      let horaFinal = horaColD || '--:--';

      // Se a Coluna D vier com data e hora juntas (ex: "19/11/2026 12:20"), extrai os dois para o tooltip
      if (horaColD.includes(' ')) {
        const partes = horaColD.split(' ');
        diaFinal = partes[0];
        horaFinal = partes[1];
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

    const resultadoFinal: DemandaAnoData[] = [];
    agrupamentoPorAno.forEach((usinasMap, ano) => {
      resultadoFinal.push({
        ano,
        dados: Array.from(usinasMap.values()),
      });
    });

    return resultadoFinal.sort((a, b) => b.ano - a.ano);
  } catch (error) {
    console.error('Erro ao carregar dados do Google Sheets:', error);
    return [];
  }
}