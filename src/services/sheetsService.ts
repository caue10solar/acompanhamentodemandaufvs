// ID oficial extraído da sua folha de cálculo Google Sheets
export const SPREADSHEET_ID = '1GsN74WrnAnXOVKx6ltlmKUCFrtGYh4P6cztk_2pbBjA';

// NOME DA ABA ONDE FICAM OS DADOS BRUTOS DIÁRIOS
const NOME_ABA_DADOS_BRUTOS = 'Coleta de dados demanda';

export interface UsinaDemandaItem {
  usina: string;
  ano: number;
  meses: { [mes: string]: number }; // Mantém a compatibilidade com o resto do site
  detalhesPico: { [mes: string]: { dia: string; hora: string } }; // NOVO: Guarda o dia e hora do pico
}

export interface DemandaAnoData {
  ano: number;
  dados: UsinaDemandaItem[];
}

// Leitor CSV nativo robusto (não necessita de bibliotecas externas)
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

/**
 * Lê os dados brutos, agrupa por ano/mês e guarda o dia e hora do maior pico
 */
export async function carregarTodosOsAnosDinamicos(spreadsheetId = SPREADSHEET_ID): Promise<DemandaAnoData[]> {
  const nomeAba = encodeURIComponent(NOME_ABA_DADOS_BRUTOS);
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${nomeAba}&t=${Date.now()}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return [];

    const csvText = await res.text();
    if (csvText.includes('<!DOCTYPE html>')) return [];

    const rows = parseCsvLinhas(csvText);
    if (rows.length < 2) return []; // Precisa ter pelo menos o cabeçalho e 1 linha

    const mesesNomes = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    
    // Mapas para organizar os dados: Ano -> Nome da Usina -> UsinaDemandaItem
    const agrupamentoPorAno = new Map<number, Map<string, UsinaDemandaItem>>();

    // Loop a partir da linha 1 para ignorar o cabeçalho
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r[0] || r[0].trim() === '') continue; // Ignora linhas vazias

      // Colunas da sua planilha "Coleta de dados demanda"
      const dataStr = r[0].trim(); // Coluna A: Data (ex: 19/10/2026)
      const usinaBruta = r[1] ? r[1].trim() : '';
const usina = usinaBruta
  .replace(/^Solar Field\s*/i, '') // Remove "Solar Field " do início
  .replace(/:\s*Active Power$/i, '') // Remove ": Active Power" do final
  .trim();
      const potenciaStr = r[2] ? r[2].replace(/\./g, '').replace(',', '.') : '0'; // Coluna C: Potência
      const potencia = parseFloat(potenciaStr) || 0;
      const horaStr = r[3] ? r[3].trim() : ''; // Coluna D: Hora (ex: 10:00)

      // Extrai dia, mês e ano da string de data (assumindo formato DD/MM/YYYY)
      const partesData = dataStr.split('/');
      if (partesData.length !== 3) continue;
      
      const mesIdx = parseInt(partesData[1], 10) - 1;
      const ano = parseInt(partesData[2], 10);

      if (isNaN(ano) || isNaN(mesIdx) || mesIdx < 0 || mesIdx > 11) continue;
      const mesNome = mesesNomes[mesIdx];

      // Inicializa os agrupamentos se ainda não existirem
      if (!agrupamentoPorAno.has(ano)) {
        agrupamentoPorAno.set(ano, new Map());
      }
      const usinasDoAno = agrupamentoPorAno.get(ano)!;

      if (!usinasDoAno.has(usina)) {
        usinasDoAno.set(usina, {
          usina,
          ano,
          meses: {},
          detalhesPico: {}
        });
      }

      // Lógica do Pico: Compara se o valor da linha atual é maior que o valor salvo
      const usinaData = usinasDoAno.get(usina)!;
      const picoAtualNoMes = usinaData.meses[mesNome] || 0;

     if (potencia > picoAtualNoMes) {
     usinaData.meses[mesNome] = potencia;

     let diaFinal = dataStr;
     let horaFinal = horaStr;

     // Se a Coluna D já tiver data e hora juntas (ex: "28/02/2025 12:20")
     if (horaStr.includes(' ')) {
       const partes = horaStr.split(' ');
       diaFinal = partes[0];
       horaFinal = partes[1];
     }

     usinaData.detalhesPico[mesNome] = { dia: diaFinal, hora: horaFinal };
   }

    // Transforma o Map numa lista (Array) organizada para o site exibir
    const resultadoFinal: DemandaAnoData[] = [];
    
    agrupamentoPorAno.forEach((usinasMap, ano) => {
      resultadoFinal.push({
        ano: ano,
        dados: Array.from(usinasMap.values())
      });
    });

    // Ordena do ano mais recente para o mais antigo (ex: 2026, 2025, 2024)
    return resultadoFinal.sort((a, b) => b.ano - a.ano);

  } catch (error) {
    console.error("Erro ao carregar dados do Google Sheets:", error);
    return [];
  }
}