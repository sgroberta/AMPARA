/* AMPARA – gráfico da página Estatística (Chart.js) */
(function () {
  "use strict";

  const canvas = document.getElementById("grafico");
  if (!canvas || typeof Chart === "undefined") return;

  // ----- Dados de exemplo: troque pelos dados reais -----
  const rotulos = ["Item 1", "Item 2", "Item 3", "Item 4", "Item 5", "Item 6"];
  const valores = [60, 89, 71, 89, 61, 100];
  // ------------------------------------------------------

  const css = getComputedStyle(document.documentElement);
  const roxo = css.getPropertyValue("--purple").trim() || "#6f5788";
  const tinta = css.getPropertyValue("--ink").trim() || "#2f2340";
  const fonte = css.getPropertyValue("--font").trim() || "Poppins, sans-serif";

  const semAnimacao = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  Chart.defaults.font.family = fonte;
  Chart.defaults.color = tinta;

  const grafico = new Chart(canvas, {
    type: "bar",
    data: {
      labels: rotulos,
      datasets: [{
        label: "Exemplo",
        data: valores,
        backgroundColor: roxo,
        hoverBackgroundColor: "#5d4676",
        borderRadius: 0,
        maxBarThickness: 46,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: semAnimacao ? false : { duration: 800 },
      layout: { padding: { left: 16, right: 16 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (ctx) => ` ${ctx.parsed.y}` }, // ex.: ` 80%` quando houver porcentagem
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: tinta, width: 1 },
          ticks: { display: false }, // como no design; mude para true para mostrar os rótulos
        },
        y: {
          display: false,
          beginAtZero: true,
          max: 100,
        },
      },
    },
  });

  // ----- Dados reais do back end (se ainda não houver denúncias, mantém o exemplo) -----
  fetch("/api/estatisticas")
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => {
      if (!d.total || !d.por_tipo.length) return;
      grafico.data.labels = d.por_tipo.map((t) => t.nome);
      grafico.data.datasets[0].data = d.por_tipo.map((t) => t.total);
      grafico.data.datasets[0].label = "Denúncias";
      grafico.options.scales.y.max = undefined;
      grafico.update();
      document.getElementById("chart-title").textContent = "Denúncias por tipo de violência";
      canvas.setAttribute(
        "aria-label",
        "Gráfico de barras: " + d.por_tipo.map((t) => `${t.nome}: ${t.total}`).join("; ")
      );
    })
    .catch(() => { /* sem back end: mantém o gráfico de exemplo */ });
})();
