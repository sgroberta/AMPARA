/* AMPARA – lógica do formulário de denúncia em etapas */
(function () {
  "use strict";

  const form = document.getElementById("form-denuncia");
  const steps = document.querySelectorAll(".step");
  const panels = document.querySelectorAll(".panel");
  const btnVoltar = document.getElementById("btn-voltar");
  const btnContinuar = document.getElementById("btn-continuar");
  const revisao = document.getElementById("revisao");
  const confirmacao = document.getElementById("confirmacao");
  const inputArquivos = document.getElementById("arquivos");
  const listaArquivos = document.getElementById("lista-arquivos");
  const inputData = document.getElementById("data");

  const TOTAL = panels.length;
  let atual = 1;

  // não permite datas futuras
  inputData.max = new Date().toISOString().split("T")[0];

  function mostrarEtapa(n) {
    atual = n;

    panels.forEach((p) => p.classList.toggle("is-active", Number(p.dataset.panel) === n));

    steps.forEach((s) => {
      const i = Number(s.dataset.step);
      s.classList.toggle("is-active", i === n);
      s.classList.toggle("is-done", i < n);
      if (i === n) s.setAttribute("aria-current", "step");
      else s.removeAttribute("aria-current");
    });

    btnVoltar.hidden = n === 1;

    const rotulo = btnContinuar.querySelector("span");
    rotulo.textContent = n === TOTAL ? "Enviar denúncia" : "Continuar";

    if (n === TOTAL) montarRevisao();

    // leva o foco para o início do painel (acessibilidade)
    const primeiro = document.querySelector(`.panel[data-panel="${n}"] input, .panel[data-panel="${n}"] textarea, .panel[data-panel="${n}"] select`);
    if (primeiro) primeiro.focus({ preventScroll: true });
  }

  function formatarData(valor) {
    if (!valor) return "";
    const [a, m, d] = valor.split("-");
    return `${d}/${m}/${a}`;
  }

  function linha(titulo, valor) {
    const dt = document.createElement("dt");
    dt.textContent = titulo;
    const dd = document.createElement("dd");
    if (valor) {
      dd.textContent = valor; // textContent evita injeção de HTML
    } else {
      dd.textContent = "Não informado";
      dd.className = "vazio";
    }
    revisao.append(dt, dd);
  }

  function montarRevisao() {
    const dados = new FormData(form);
    const tipos = dados.getAll("tipos").join(", ");
    const arquivos = Array.from(inputArquivos.files).map((f) => f.name).join(", ");

    revisao.replaceChildren();
    linha("O que aconteceu", (dados.get("descricao") || "").trim());
    linha("Local", (dados.get("local") || "").trim());
    linha("Data", formatarData(dados.get("data")));
    linha("O que foi vivenciado", tipos);
    linha("Tipo de serviço", dados.get("servico"));
    linha("Momento do atendimento", dados.get("momento"));
    linha("Evidências anexadas", arquivos);
  }

  inputArquivos.addEventListener("change", () => {
    listaArquivos.replaceChildren();
    Array.from(inputArquivos.files).forEach((f) => {
      const li = document.createElement("li");
      li.textContent = f.name;
      listaArquivos.appendChild(li);
    });
  });

  btnVoltar.addEventListener("click", () => {
    if (atual > 1) mostrarEtapa(atual - 1);
  });

  btnContinuar.addEventListener("click", () => {
    if (atual < TOTAL) {
      mostrarEtapa(atual + 1);
    } else {
      enviar();
    }
  });

  // clique direto nos círculos das etapas já visitadas
  steps.forEach((s) => {
    s.addEventListener("click", () => {
      const i = Number(s.dataset.step);
      if (i < atual) mostrarEtapa(i);
    });
  });

  function enviar() {
    const dados = new FormData(form);

    /* TODO: enviar ao back end, por exemplo:
       fetch("/api/denuncias", { method: "POST", body: dados })
         .then(...)
       Não envie IP, cookies de identificação nem dados pessoais:
       a denúncia deve permanecer anônima. */
    console.log("Denúncia pronta para envio:", Object.fromEntries(dados));

    btnContinuar.disabled = true;
    btnVoltar.hidden = true;
    confirmacao.hidden = false;
    confirmacao.focus?.();
  }

  // Enter em campos de texto não deve enviar nem pular etapa sem querer
  form.addEventListener("submit", (e) => e.preventDefault());
})();
