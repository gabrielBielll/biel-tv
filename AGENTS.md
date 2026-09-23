# Referências operacionais

- Antes de cortar, reenquadrar ou publicar comerciais, vinhetas, chamadas ou
  programas de acervo em 16:9, leia
  [docs/PROCESSO_COMERCIAIS_16X9.md](docs/PROCESSO_COMERCIAIS_16X9.md).
  Ele contém o filtro visual aprovado, a política de minutagem, proteção dos
  arquivos-fonte e a publicação no R2/D1.

- **Bloqueio operacional — comerciais automáticos da Jetix (2026-09-22):**
  antes de gerar, cadastrar, publicar ou agendar qualquer peça derivada da
  grade, leia
  [docs/features/modulo-comerciais-jetix.md](docs/features/modulo-comerciais-jetix.md).
  A automação está bloqueada até Gabriel confirmar explicitamente que terminou
  a alteração da grade. Os renders locais já aprovados podem ser preservados e
  inspecionados, mas a grade atual não pode ser usada como fonte de verdade.

- **Quadro de Tarefas Trello (`biel-tv/web-tv-react`):**
  - Quadro ID: `686286afd360e39b2adccd4d` (https://trello.com/b/Rik3Xgyr/biel-tv-web-tv-react)
  - Colunas:
    - Backlog: `6aaca42a5d892e4661416126`
    - A fazer: `686286bea4756d9e552b95e2`
    - Fazendo: `686286ca26b737669532258a`
    - Feito: `686286cf59c3907a2174b3b9`
  - Credenciais: mantidas isoladas exclusivamente no escopo do projeto via `.envrc` e no cofre local (`secrets/trello-credentials.env`), nunca comitadas nem expostas em logs públicos.
