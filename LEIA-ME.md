# Iron Horizons: RPG — protótipo multijogador

Este projeto tem duas partes: o servidor (`server.js`) e o jogo (`index.html`). O servidor também entrega o jogo, por isso basta correr um só programa. Não é preciso instalar nada além do Node.js (versão 18 ou superior, em nodejs.org).

## 1. Correr no teu computador

1. Descomprime a pasta.
2. Abre um terminal dentro dela e escreve: `node server.js`
3. Abre http://localhost:3000 no Chrome.

## 2. Jogar com amigos na mesma rede

1. Descobre o endereço do teu computador na rede (no Windows: `ipconfig`; no Mac ou Linux: `ifconfig`). Procura algo como 192.168.1.23.
2. O amigo abre `http://192.168.1.23:3000` (com o teu endereço) no Chrome.
3. Se não ligar, pode ser a firewall do computador ou a rede (algumas escolas bloqueiam ligações entre computadores).

## 3. Jogar cada um em sua casa (servidor online)

O servidor tem de estar num serviço de alojamento que aceite WebSockets. Os passos são os mesmos em quase todos:

1. Pôr esta pasta num repositório (por exemplo, no GitHub).
2. Criar um serviço web Node.js nesse repositório.
3. Comando de arranque: `node server.js` (o serviço define a porta sozinho através de PORT).
4. Abrir o endereço https que o serviço der. O jogo liga-se sozinho ao mesmo endereço.

Os planos gratuitos mudam com frequência e alguns adormecem quando ninguém joga (o primeiro a entrar espera uns segundos). Verifica as condições atuais antes de escolher.

## Controlos

WASD ou setas: andar. Rato (arrastar): câmara. Roda do rato: zoom. Espaço: habilidade. Enter: falar. C: mudar de classe.

## Contas e progresso

- Cada jogador cria uma conta (nome e palavra-passe). As palavras-passe são guardadas já misturadas (nunca em texto simples).
- O nível, a experiência e a classe são guardados quando sobes de nível, mudas de classe, sais, e a cada 5 minutos.
- **Base de dados online (necessária na Render):** cria uma base Redis gratuita na Upstash e define no teu serviço duas variáveis de ambiente: `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` (valores da secção REST API da base de dados).
- Sem estas variáveis, as contas ficam no ficheiro `accounts.json`. Serve para testar no teu computador, mas na Render perde-se sempre que o servidor reinicia.

## Combate

- Fora de Portavel há lobos e goblins. Dentro da aldeia (e no cais) estás seguro e recuperas vida.
- Cada classe ataca com a sua habilidade (Espaço). A bola do Mago viaja até ao alvo e só causa dano quando o atinge. Os monstros dão experiência e, ao subires de nível, ficas com mais vida e mais dano.
- Se a vida chegar a zero, voltas a Portavel com a vida cheia. Os monstros renascem ao fim de 20 segundos.
- Todo o combate é decidido no servidor.

## Notas técnicas

- Máximo de 20 jogadores. As posições são validadas no servidor (limites do mapa e velocidade).
- Os nomes e as mensagens são limpos no servidor. Não há filtro de palavras.
- O jogo carrega o Three.js a partir do cdnjs. Se a rede da escola o bloquear, avisa-me e mudamos.
- Ainda não há inventário nem itens guardados.

Esta versão tem os 4 ficheiros todos na mesma pasta, sem subpastas, para ser fácil de carregar no GitHub.
