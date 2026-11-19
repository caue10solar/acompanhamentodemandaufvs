import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { SheetParseResult, UsinaMonthlyRecord, PeriodOption, PeriodFilterMode } from './types/demand';
import { parseSheetCsv, mergeSheetResults } from './utils/demandParser';
import { exportMonthlyRecordsToCsv } from './utils/exportMonthlyCsv';
import {
  generatePeriodOptions,
  getOverDemandReport,
  getUnderDemandReport,
  exportOverDemandToCsv,
  exportUnderDemandToCsv,
  exportPeriodSummaryToCsv,
} from './utils/deviationReports';
import { Header, AppTab } from './components/Header';
import { PeriodSelector } from './components/PeriodSelector';
import { DataSourceToolbar } from './components/DataSourceToolbar';
import { OverDemandReport } from './components/OverDemandReport';
import { UnderDemandReport } from './components/UnderDemandReport';
import { PlantSelector } from './components/PlantSelector';
import { PlantSummaryCards } from './components/PlantSummaryCards';
import { DemandChart } from './components/DemandChart';
import { MonthlyDetailTable } from './components/MonthlyDetailTable';
import { AllPlantsRankingTable } from './components/AllPlantsRankingTable';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react';
import { carregarDadosCompletosSheets, normalizarChaveUsina } from './services/sheetsService';

export default function App() {
  const [sheetResult, setSheetResult] = useState<SheetParseResult | null>(null);
  const [selectedUsinaId, setSelectedUsinaId] = useState<string>('');
  const [currentUrl, setCurrentUrl] = useState<string>('Conectando ao Google Sheets...');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<AppTab>('dashboard');
  const [filterMode, setFilterMode] = useState<PeriodFilterMode>('all');

  const [selectedMonthIndex, setSelectedMonthIndex] = useState<number>(11);
  const [selectedYear, setSelectedYear] = useState<number>(2026);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 4000);
  };

  const fetchData = useCallback(async (forcarAtualizacao = false) => {
    setIsLoading(true);
    setError(null);

    try {
      // 1. Busca os dados da coleta + cadastro (Colunas A, B e C da aba "Informações de demanda")
      const { anos: dadosDinamicos, cadastro } = await carregarDadosCompletosSheets(undefined, forcarAtualizacao);

      if (!dadosDinamicos || dadosDinamicos.length === 0) {
        throw new Error('Não foi possível carregar os dados da planilha Google Sheets.');
      }

      // 2. Converte e amarra cada usina diretamente com as Colunas A, B e C da planilha
      const usinasMap = new Map<string, any>();
      const availableYears = new Set<number>();

      const mesesShort = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
      const mesesFull = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

      dadosDinamicos.forEach((anoData) => {
        availableYears.add(anoData.ano);

        anoData.dados.forEach((usinaData) => {
          const nome = usinaData.usina;
          if (!usinasMap.has(nome)) {
            const chave = normalizarChaveUsina(nome);
            const infoPlanilha = cadastro[chave];

            // Usa exclusivamente o que está na planilha (Coluna B e Coluna C)
            const contractedDemandKw = infoPlanilha ? infoPlanilha.contractedDemandKw : 1000;
            const toleranceLimitKw = infoPlanilha ? infoPlanilha.toleranceLimitKw : Number((contractedDemandKw * 1.03).toFixed(2));
            const threshold5PctKw = infoPlanilha ? infoPlanilha.threshold5PctKw : Number((contractedDemandKw * 0.05).toFixed(2));

            usinasMap.set(nome, {
              id: nome,
              name: nome,
              contractedDemandKw,
              toleranceLimitKw,
              threshold5PctKw,
              isExceededAnyMonth: false,
              isUnderutilizedAnyMonth: false,
              exceededMonthsCount: 0,
              months: [],
              availableYears: [],
            });
          }

          const usinaRecord = usinasMap.get(nome);
          if (!usinaRecord.availableYears.includes(anoData.ano)) {
            usinaRecord.availableYears.push(anoData.ano);
          }

          mesesShort.forEach((mesSigla, index) => {
            const potencia = usinaData.meses[mesSigla];
            if (potencia !== undefined && potencia !== null && potencia > 0) {
              const isExceeded = potencia > usinaRecord.toleranceLimitKw;
              const isUnder = potencia < usinaRecord.threshold5PctKw;

              if (isExceeded) {
                usinaRecord.isExceededAnyMonth = true;
                usinaRecord.exceededMonthsCount += 1;
              }
              if (isUnder) usinaRecord.isUnderutilizedAnyMonth = true;

              usinaRecord.months.push({
                year: anoData.ano,
                monthIndex: index + 1,
                monthName: mesesFull[index],
                monthShort: mesSigla,
                powerKw: potencia,
                contractedDemandKw: usinaRecord.contractedDemandKw,
                toleranceLimitKw: usinaRecord.toleranceLimitKw,
                threshold5PctKw: usinaRecord.threshold5PctKw,
                isExceeded,
                isUnderutilized: isUnder,
                excessKw: isExceeded ? Number((potencia - usinaRecord.toleranceLimitKw).toFixed(2)) : 0,
                percentageOfContracted: Number(((potencia / usinaRecord.contractedDemandKw) * 100).toFixed(1)),
                detalhesPico: usinaData.detalhesPico[mesSigla],
              });
            }
          });
        });
      });

      const usinasList = Array.from(usinasMap.values());
      const anosCarregados = Array.from(availableYears).sort((a, b) => b - a);

      const merged: any = {
        usinas: usinasList,
        usinasCount: usinasList.length,
        availableYears: anosCarregados,
        sourceType: 'sheets',
      };

      if (merged.usinas.length === 0) {
        throw new Error('Nenhuma usina encontrada nos dados da planilha.');
      }

      setSheetResult(merged);

      const anoMaisRecente = anosCarregados[0] || 2026;
      setCurrentUrl(`Google Sheets Integrado (${anosCarregados.join(', ')}) · ${merged.usinas.length} Usinas`);

      if (!anosCarregados.includes(selectedYear)) {
        setSelectedYear(anoMaisRecente);
      }

      setSelectedUsinaId((prev: any) => {
        if (prev && merged.usinas.some((u: any) => u.id === prev)) return prev;
        const exceededInLatest = merged.usinas.find((u: any) => u.months.find((p: any) => p.year === anoMaisRecente && p.isExceeded));
        if (exceededInLatest) return exceededInLatest.id;
        const firstExceeded = merged.usinas.find((u: any) => u.isExceededAnyMonth);
        return firstExceeded ? firstExceeded.id : merged.usinas[0].id;
      });

      if (forcarAtualizacao) {
        showToast(`Dados atualizados direto do Google Sheets (${anosCarregados.join(', ')})!`);
      }
    } catch (err: any) {
      console.error('Fetch error:', err);
      setError(err?.message || 'Erro ao carregar dados operacionais.');
      showToast('Erro ao atualizar base de dados.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(false);
  }, [fetchData]);

  const handleFileUpload = (file: File) => {
    setIsLoading(true);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const parsed = parseSheetCsv(text, file.name);
        if (parsed.usinas.length === 0) {
          throw new Error('O arquivo CSV enviado não contém usinas válidas.');
        }

        const merged = sheetResult ? mergeSheetResults([sheetResult, parsed]) : parsed;
        setSheetResult(merged);

        const firstExceeded = merged.usinas.find((u) => u.isExceededAnyMonth);
        setSelectedUsinaId(firstExceeded ? firstExceeded.id : merged.usinas[0].id);
        showToast(`Arquivo "${file.name}" importado e integrado com sucesso (${merged.usinas.length} usinas).`);
      } catch (err: any) {
        setError(err?.message || 'Falha ao processar arquivo CSV.');
        showToast('Erro ao processar arquivo.');
      } finally {
        setIsLoading(false);
      }
    };
    reader.readAsText(file, 'utf-8');
  };

  const handleExportCsv = () => {
    if (sheetResult && sheetResult.usinas.length > 0) {
      exportMonthlyRecordsToCsv(sheetResult.usinas);
      showToast('Download da matriz consolidada em CSV iniciado.');
    }
  };

  // Usa diretamente os valores amarrados da planilha (Coluna B e Coluna C) sem sobrescrever!
  const selectedUsina: UsinaMonthlyRecord | null = useMemo(() => {
    if (!sheetResult || sheetResult.usinas.length === 0) return null;
    return sheetResult.usinas.find((u) => u.id === selectedUsinaId) || sheetResult.usinas[0];
  }, [sheetResult, selectedUsinaId]);

  const periodOptions: PeriodOption[] = useMemo(() => {
    if (!sheetResult || sheetResult.usinas.length === 0) return [];
    return generatePeriodOptions(sheetResult.usinas, sheetResult.availableYears);
  }, [sheetResult]);

  const currentPeriod = useMemo(() => {
    return (
      periodOptions.find((p) => p.monthIndex === selectedMonthIndex && p.year === selectedYear) ||
      periodOptions[0]
    );
  }, [periodOptions, selectedMonthIndex, selectedYear]);

  const overDemandItems = useMemo(() => {
    if (!sheetResult || sheetResult.usinas.length === 0) return [];
    return getOverDemandReport(sheetResult.usinas, selectedMonthIndex, selectedYear);
  }, [sheetResult, selectedMonthIndex, selectedYear]);

  const underDemandItems = useMemo(() => {
    if (!sheetResult || sheetResult.usinas.length === 0) return [];
    return getUnderDemandReport(sheetResult.usinas, selectedMonthIndex, selectedYear, true);
  }, [sheetResult, selectedMonthIndex, selectedYear]);

  const displayedUsinas = useMemo(() => {
    if (!sheetResult || sheetResult.usinas.length === 0) return [];
    if (filterMode === 'all') return sheetResult.usinas;

    if (filterMode === 'over_3') {
      return sheetResult.usinas.filter((u) => {
        const monthData = u.months.find((m) => m.monthIndex === selectedMonthIndex && m.year === selectedYear);
        return monthData && monthData.powerKw !== null && monthData.powerKw > u.toleranceLimitKw;
      });
    }

    if (filterMode === 'under_5') {
      return sheetResult.usinas.filter((u) => {
        const monthData = u.months.find((m) => m.monthIndex === selectedMonthIndex && m.year === selectedYear);
        const powerKw = monthData?.powerKw ?? null;
        return powerKw === null || powerKw === 0 || (u.threshold5PctKw > 0 && powerKw < u.threshold5PctKw);
      });
    }

    return sheetResult.usinas;
  }, [sheetResult, filterMode, selectedMonthIndex, selectedYear]);

  useEffect(() => {
    if (displayedUsinas.length > 0 && !displayedUsinas.some((u) => u.id === selectedUsinaId)) {
      setSelectedUsinaId(displayedUsinas[0].id);
    }
  }, [displayedUsinas, selectedUsinaId]);

  const currentUsinaIndex = useMemo(() => {
    if (!displayedUsinas || !selectedUsina) return 0;
    const idx = displayedUsinas.findIndex((u) => u.id === selectedUsina.id);
    return idx >= 0 ? idx : 0;
  }, [displayedUsinas, selectedUsina]);

  const handleExportActiveExcel = () => {
    if (!sheetResult || sheetResult.usinas.length === 0) return;
    const periodLabel = currentPeriod?.label || `${selectedMonthIndex}/${selectedYear}`;

    if (filterMode === 'over_3') {
      exportOverDemandToCsv(overDemandItems, periodLabel);
      showToast(`Exportação de ${overDemandItems.length} usinas acima de +3% concluída em Excel.`);
    } else if (filterMode === 'under_5') {
      exportUnderDemandToCsv(underDemandItems, periodLabel);
      showToast(`Exportação de ${underDemandItems.length} usinas abaixo de 5% concluída em Excel.`);
    } else {
      exportPeriodSummaryToCsv(sheetResult.usinas, selectedMonthIndex, selectedYear);
      showToast(`Resumo operacional de ${periodLabel} exportado para Excel.`);
    }
  };

  const handleSelectUsinaForChart = (usinaId: string) => {
    setSelectedUsinaId(usinaId);
    setActiveTab('dashboard');
    showToast('Exibindo gráfico e detalhes da usina selecionada.');
  };

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans selection:bg-blue-600 selection:text-white">
        {toastMessage && (
          <div className="fixed bottom-5 right-5 z-50 flex items-center gap-2 bg-slate-900 text-white px-4 py-3 rounded-xl shadow-xl text-xs font-semibold animate-in fade-in slide-in-from-bottom-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{toastMessage}</span>
          </div>
        )}

        <Header
          onRefresh={() => fetchData(true)}
          onExportCsv={handleExportCsv}
          isLoading={isLoading}
          totalUsinas={sheetResult?.usinasCount || 0}
          exceededCount={currentPeriod?.exceededCount || 0}
          underutilizedCount={currentPeriod?.underutilizedCount || 0}
          activeTab={activeTab}
          onTabChange={(tab) => setActiveTab(tab)}
        />

        <main className="flex-1 max-w-7xl w-full mx-auto px-4 lg:px-8 py-6 space-y-6">
          <DataSourceToolbar
            sheetResult={sheetResult}
            isLoading={isLoading}
            onRefresh={() => fetchData(true)}
            onFileUpload={handleFileUpload}
            onExportCsv={handleExportCsv}
            currentUrl={currentUrl}
          />

          {periodOptions.length > 0 && (
            <PeriodSelector
              periodOptions={periodOptions}
              selectedMonthIndex={selectedMonthIndex}
              selectedYear={selectedYear}
              onSelectPeriod={(m, y) => {
                setSelectedMonthIndex(m);
                setSelectedYear(y);
              }}
              activeFilter={filterMode}
              onToggleFilter={(mode) => setFilterMode(mode)}
              onExportExcel={handleExportActiveExcel}
              filteredCount={displayedUsinas.length}
              overDemandItems={overDemandItems}
              selectedUsinaId={selectedUsina?.id}
              onSelectUsina={(id) => {
                setSelectedUsinaId(id);
                showToast('Usina selecionada para foco no gráfico.');
              }}
            />
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl text-xs flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-red-600" />
                <span>{error}</span>
              </div>
              <button
                type="button"
                onClick={() => fetchData(true)}
                className="px-2.5 py-1 bg-red-100 hover:bg-red-200 rounded font-bold text-red-800 transition-colors cursor-pointer"
              >
                Tentar Novamente
              </button>
            </div>
          )}

          {isLoading && !sheetResult && (
            <div className="flex flex-col items-center justify-center py-20 text-slate-400 space-y-3">
              <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
              <p className="text-sm font-semibold text-slate-600">
                Sincronizando abas do Google Sheets em tempo real...
              </p>
              <p className="text-xs text-slate-400">
                Calculando demandas contratadas, margem (+3%) e subutilização (&lt; 5%).
              </p>
            </div>
          )}

          {sheetResult && selectedUsina && (
            <>
              {activeTab === 'dashboard' && (
                <div className="space-y-6">
                  <section aria-label="Filtro de Usina">
                    <PlantSelector
                      usinas={displayedUsinas}
                      selectedUsinaId={selectedUsina.id}
                      onSelectUsina={(id) => setSelectedUsinaId(id)}
                      activeFilter={filterMode}
                      onClearFilter={() => setFilterMode('all')}
                      periodLabel={currentPeriod?.label}
                      totalOriginalCount={sheetResult.usinas.length}
                    />
                  </section>

                  <section aria-label="Resumo da Usina">
                    <PlantSummaryCards
                      usina={selectedUsina}
                      totalUsinasCount={displayedUsinas.length}
                      currentUsinaIndex={currentUsinaIndex}
                      selectedYear={selectedYear}
                      selectedMonthIndex={selectedMonthIndex}
                    />
                  </section>

                  <section aria-label="Gráfico de Demanda">
                    <DemandChart
                      usina={selectedUsina}
                      selectedYear={selectedYear}
                      onSelectYear={(yr) => setSelectedYear(yr)}
                    />
                  </section>

                  <section aria-label="Detalhamento Mensal">
                    <MonthlyDetailTable
                      usina={selectedUsina}
                      selectedYear={selectedYear}
                      selectedMonthIndex={selectedMonthIndex}
                    />
                  </section>

                  <section aria-label="Ranking de Usinas da Frota">
                    <AllPlantsRankingTable
                      usinas={displayedUsinas}
                      selectedUsinaId={selectedUsina.id}
                      onSelectUsina={(id) => setSelectedUsinaId(id)}
                      activeFilter={filterMode}
                      periodLabel={currentPeriod?.label}
                      onClearFilter={() => setFilterMode('all')}
                    />
                  </section>
                </div>
              )}

              {activeTab === 'report_over_3' && (
                <section aria-label="Relatório de Superação Acima de 3%">
                  <OverDemandReport
                    reportItems={overDemandItems}
                    periodLabel={currentPeriod?.label || `${selectedMonthIndex}/${selectedYear}`}
                    onSelectUsinaForChart={handleSelectUsinaForChart}
                    onToast={showToast}
                  />
                </section>
              )}

              {activeTab === 'report_under_5' && (
                <section aria-label="Relatório de Subutilização Abaixo de 5%">
                  <UnderDemandReport
                    reportItems={underDemandItems}
                    periodLabel={currentPeriod?.label || `${selectedMonthIndex}/${selectedYear}`}
                    onSelectUsinaForChart={handleSelectUsinaForChart}
                    onToast={showToast}
                  />
                </section>
              )}
            </>
          )}
        </main>

        <footer className="bg-white border-t border-slate-200 mt-12 py-5 text-center text-xs text-slate-500">
          <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
            <span>
              Monitor Operacional de Demanda de Usinas · Google Sheets Integrado em Tempo Real
            </span>
            <span className="font-mono text-slate-400">
              Critérios de Corte: Ultrapassagem &gt; +3% · Subutilização &lt; 5%
            </span>
          </div>
        </footer>
      </div>
    </ErrorBoundary>
  );
}