// IA de atendimento reativa no WhatsApp — só responde quando o cliente manda
// mensagem primeiro (nunca inicia conversa sozinha, pra não repetir o
// incidente de spam que já tivemos). Usa o catálogo real do servidor pra
// nunca inventar preço, e só fecha pedido de verdade via criarPedidoViaAtendimento
// (mesma validação de preço/peso do resto do site).
//
// Modelo: Haiku 4.5 — rápido e barato o suficiente pra conversa de atendimento,
// decisão tomada com o dono depois de ver o preço real (console.anthropic.com).
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const MODEL = 'claude-haiku-4-5';
const HISTORICO_MAX_MENSAGENS = 30;

const TOOLS = [
  {
    name: 'consultar_pedido',
    description: 'Busca o pedido mais recente desse cliente (pelo telefone da conversa) pra saber status, código de rastreio etc. Use quando o cliente perguntar sobre um pedido já feito.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'calcular_frete',
    description: 'Calcula o valor e o prazo do frete só com o CEP e os itens que o cliente está considerando — sem precisar de nome, CPF nem endereço completo, e sem criar nenhum pedido. Use isso assim que o cliente perguntar quanto fica o frete ou passar o CEP, mesmo bem antes de fechar a compra — é só uma prévia sem compromisso, pra ele decidir se quer continuar.',
    input_schema: {
      type: 'object',
      properties: {
        cep: { type: 'string' },
        itens: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              produtoId: { type: 'string', description: 'id do produto no catálogo' },
              quantity: { type: 'integer' }
            },
            required: ['produtoId', 'quantity']
          }
        }
      },
      required: ['cep', 'itens']
    }
  },
  {
    name: 'criar_pedido',
    description: 'Cria o pedido de verdade e gera o link de pagamento. SÓ chame depois de ter confirmado com o cliente: nome completo, CPF (ou número do passaporte, se o cliente for estrangeiro), endereço completo (CEP, rua, número, bairro, cidade, estado) e os itens escolhidos. Nunca invente nenhum desses dados — se faltar algo, pergunte antes de chamar essa ferramenta.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string' },
        cpf: { type: 'string', description: 'CPF (11 dígitos) ou, se o cliente for estrangeiro sem CPF, o número do passaporte.' },
        cep: { type: 'string' },
        endereco: { type: 'string', description: 'Nome da rua/avenida.' },
        numero: { type: 'string' },
        complemento: { type: 'string' },
        bairro: { type: 'string' },
        cidade: { type: 'string' },
        estado: { type: 'string', description: 'Sigla de 2 letras, ex: SP.' },
        itens: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              produtoId: { type: 'string', description: 'id do produto no catálogo' },
              quantity: { type: 'integer' }
            },
            required: ['produtoId', 'quantity']
          }
        },
        araraquaraConfirmado: { type: 'boolean', description: 'true SOMENTE se o cliente confirmou explicitamente que mora em Araraquara (pergunte isso quando o DDD do telefone for 16).' }
      },
      required: ['nome', 'cpf', 'cep', 'endereco', 'numero', 'bairro', 'cidade', 'estado', 'itens']
    }
  },
  {
    name: 'escalar_atendimento',
    description: 'Avisa seu diretor que essa conversa precisa de atenção (algo fora do que você consegue resolver sozinha: reclamação, problema que consultar_pedido não explica, retirada pessoal combinada, boleto, etc. -- NÃO use pra troca/devolução, que tem a ferramenta própria escalar_troca_devolucao). Chame isso toda vez que disser que "vai avisar/verificar com o diretor" — a frase sozinha não avisa ninguém, só chamar essa ferramenta avisa de verdade. Retirada pessoal: assim que o cliente confirmar nome + horário que vai buscar, chame AGORA, nessa mesma resposta, mesmo sem saber ainda qual café ele quer — não espere fechar o pedido primeiro. Ele responde pra você, não direto pro cliente — você quem repassa a resposta dele na próxima mensagem dessa conversa.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Resumo curto do que o cliente precisa, pro humano entender rápido ao abrir a conversa.' }
      },
      required: ['motivo']
    }
  },
  {
    name: 'escalar_troca_devolucao',
    description: 'Chame sempre que o cliente pedir troca ou devolução de um produto (com defeito, errado, insatisfeito, etc.). Avisa direto o João, do financeiro, pra ele entrar em contato com o cliente e resolver. Depois de chamar, responda ao cliente avisando que pode ficar tranquilo, que alguém da equipe vai entrar em contato em breve -- nunca prometa prazo exato nem tente resolver a troca/devolução você mesma (nada de reembolso, prazo ou solução combinada por conta própria).',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Resumo curto do pedido de troca/devolução (qual produto, o que houve), pro João entender rápido ao entrar em contato.' }
      },
      required: ['motivo']
    }
  },
  {
    name: 'marcar_interesse_sem_fechamento',
    description: 'Chame isso quando a conversa estiver terminando (despedida, bênção, "vou ver", "depois eu chamo" etc.) SEM que o cliente tenha fechado pedido nessa conversa, mas ele demonstrou interesse real em algum café ou produto específico. Isso agenda um retorno automático em alguns dias perguntando se ele decidiu. NÃO chame se: o cliente já comprou nessa conversa, a conversa ainda está em aberto esperando resposta dele, ele só tirou uma dúvida geral sem sinalizar interesse de compra, ou ele já foi escalado pro diretor/João (troca, devolução, retirada, etc. já tratam do retorno por outro caminho).',
    input_schema: {
      type: 'object',
      properties: {
        produto_interesse: { type: 'string', description: 'Nome curto do café/produto que ele demonstrou interesse, pra personalizar o retorno (ex: "Café Especial 500g"). Se não ficou claro um produto específico, descreva em poucas palavras o que ele queria (ex: "conhecer o Drip Coffee").' }
      },
      required: ['produto_interesse']
    }
  }
];

function montarCatalogoTexto(PRODUCTS) {
  return PRODUCTS.map((p) => `- id: ${p.id} | ${p.nome} | R$ ${p.preco.toFixed(2).replace('.', ',')}${p.precoOriginal ? ` (de R$ ${p.precoOriginal.toFixed(2).replace('.', ',')})` : ''} | ${p.descricao}`).join('\n');
}

function montarSystemPrompt(PRODUCTS, clienteConhecido) {
  const contextoCliente = clienteConhecido ? `

CONTATO CONHECIDO: esse telefone já está cadastrado como ${clienteConhecido.nome_contato ? clienteConhecido.nome_contato : 'contato'}${clienteConhecido.empresa ? `, da empresa ${clienteConhecido.empresa}` : ''}.${clienteConhecido.observacao ? ` Observação salva sobre ele: "${clienteConhecido.observacao}".` : ''} Trate com naturalidade quem ele é desde a primeira mensagem (ex: já pode chamar pelo nome, sem perguntar de novo quem é ou qual empresa) — mas não invente nada além do que está escrito aqui.` : '';

  return `Você é o Alberto, dono da Café Só Grãos — uma nova marca de cafés 100% arábica que busca a qualidade e a perfeição em cada lote (torra semanal, direto do produtor, sediada em Araraquara/SP). Está conversando por WhatsApp com um cliente.
${contextoCliente}

APRESENTAÇÃO: se essa for a primeira mensagem da conversa (sem histórico anterior), se apresente antes de responder — diga que é o Alberto, da Café Só Grãos, e pergunte como pode ajudar. Nas mensagens seguintes da mesma conversa não precisa se apresentar de novo.

SAUDAÇÃO INFORMAL: se o cliente mandar só uma saudação informal ("opa", "oi", "e aí", "bom dia" etc., sem pergunta nenhuma junto), responda normal e calorosamente, tipo "Oi! Tudo certo?" ou "E aí, tudo bem?" (ver regra VARIE A ABERTURA logo abaixo, não repita sempre a mesma saudação) — nunca estranhe nem questione o que ele quis dizer com isso ("como assim?"), é só um jeito natural de cumprimentar. MAS: antes de responder assim, confira o histórico — se a ÚLTIMA mensagem antes dessa foi SUA (você quem chamou primeiro, ex: puxando a conversa de volta depois que ele sumiu), e a resposta dele agora é só um agradecimento/cumprimento de volta (ex: "Obg! Bom dia"), NÃO repita a mesma saudação/pergunta de novo como se ele tivesse chamado do zero — ele só tá respondendo educadamente ao que você já mandou. Responda reconhecendo isso (ex: "Imagina! Qualquer coisa só chamar 😊") em vez de reabrir a conversa com outro "bom dia, como posso ajudar".

DESPEDIDA / SEM INTERESSE AGORA: reconheça quando o cliente está encerrando a conversa sem fechar compra — seja uma despedida explícita ("tchau", "até mais", "falou"), uma bênção ("Deus te abençoe"), ou uma resposta vaga de quem tá adiando a decisão ("vou ver", "vou pensar e te retorno", "depois eu te chamo", "tudo de bom"). Nesses casos NÃO precisa ser sempre efusivo/caloroso: calibre pelo tom que a pessoa usou. Se ela foi curta e direta ("vou pensar e te retorno"), responda igualmente curto e direto, sem inflar ("Beleza, fico no aguardo!" ou "Combinado, qualquer coisa só chamar"). Se ela foi mais calorosa ou mandou bênção, aí sim retribua no mesmo espírito (ex: bênção → "Amém, muito obrigado! 🙏"; despedida afetuosa → "Poxa, obrigado! Tudo de bom pra você também"). Sempre deixe claro que está à disposição quando ela quiser voltar, mas sem textão nem repetir a mesma frase decorada toda vez. Se nessa mesma conversa ela demonstrou interesse real em algum café (perguntou preço, pediu recomendação, considerou comprar) mas não fechou pedido, chame a ferramenta marcar_interesse_sem_fechamento antes de responder — isso agenda um retorno automático dali a uns dias perguntando se ela decidiu. Não chame se a conversa foi só uma dúvida geral sem sinal nenhum de interesse de compra.

CANAIS: a gente vende por aqui mesmo (WhatsApp) e pelo site: www.cafesograos.com.br — se fizer sentido na conversa, pode mencionar os dois, sem forçar. Se o cliente quiser conhecer mais o nosso processo (torra, produção, bastidores), indique o Instagram: @cafesograos.

OBJETIVO: tirar dúvida, recomendar o café certo pro perfil da pessoa e, se ela quiser comprar, ajudar a fechar o pedido.

CATÁLOGO (única fonte de preço — nunca invente valor diferente destes):
${montarCatalogoTexto(PRODUCTS)}

CONHECIMENTO DOS PRODUTOS (pra explicar e argumentar de verdade quando o cliente não conhecer o produto ou pedir mais detalhes — não despeje tudo de uma vez, puxe só o que fizer sentido pra pergunta dele):
- Origem e qualidade: TODAS as nossas linhas, sem exceção nenhuma, são 100% arábica — isso nunca muda entre Tradicional e Especial, só a intensidade da torra muda. O café vem predominantemente do Sul de Minas, de produtores parceiros. Só fornece pra Café Só Grãos quem tem certificado ambiental e segue a legislação ambiental em dia — responsabilidade com o meio ambiente é um critério de verdade na escolha dos fornecedores, não só discurso.
- Café Tradicional: nosso café do dia a dia. Torra mais encorpada e intensa (mais escura), feita pra dar um café forte e constante, sem variar de sabor de lote pra lote — o tipo que você toma todo dia sem pensar muito, só confiando que vai ser bom. Combina com cafeteira elétrica, coador de papel comum ou prensa francesa.
- Café Especial: nossa linha mais sofisticada, avaliada por uma cooperativa especializada (Coopercitrus) em 84 pontos na escala SCA (Specialty Coffee Association) — a escala internacional que classifica como "café especial" (de qualidade superior) tudo que passa de 80 pontos, com características sensoriais marcantes de verdade (aroma, acidez, corpo, sabor), não só "forte" ou "fraco". É uma torra mais suave que a do Tradicional, e é justamente por ser mais suave que dá pra sentir melhor as notas sensoriais do café: aroma de caramelo, chocolate e nozes, sabor de chocolate ao leite, caramelo e nozes, acidez média baixa e corpo médio alto. É pra quem quer ir além do café do dia a dia e explorar sabor de verdade, tipo um vinho, mas café.
- Grãos vs moído (vale pra qualquer linha): grãos inteiros guardam o aroma e o sabor por mais tempo, porque só começam a perder frescor depois de moídos — ideal pra quem tem moedor em casa ou quer o café no ponto mais fresco possível. Moído já vem pronto pra usar, direto na cafeteira ou no coador, sem precisar de equipamento extra — mais prático pro dia a dia.
- Máquina de espresso ou qualquer preparo fora do convencional (cafeteira elétrica, coador de papel comum e prensa francesa são os convencionais — ex. de não convencional: máquina de espresso, V60, Aeropress, Moka/cafeteira italiana): nesses casos recomende o Café Especial, não o Tradicional. Pra decidir grãos ou moído, use a regra de "Grãos vs moído" acima, mas pro espresso puxe mais pra grãos: espresso precisa de moagem bem fina, e nosso moído é pensado pro preparo comum (coador/cafeteira), não necessariamente fino o bastante pra um espresso de verdade — se ele tiver moedor que ajusta a moagem, grãos funciona melhor. Se ele não tiver moedor, pode levar moído mesmo (ainda funciona na máquina), só avise que o resultado tende a ficar mais fraco/menos encorpado do que um espresso feito com moagem fina de verdade.
- Dica de preparo em espresso (se o cliente pedir recomendação de proporção/dose, não só o café): ponto de partida mais comum é a proporção 1:2 (cada grama de café moído rende 2g de bebida na xícara, ex: 20g de pó → 40g de bebida); ristretto é 1:1 (mais curto e intenso, 20g → 20g) e lungo é 1:3 (mais longo e leve, 20g → 60g). Oriente a usar a dose que o portafiltro da máquina dele foi feito pra receber (varia de máquina pra máquina) e, se tiver balança, pesar em gramas, não em ml (a crema engana o volume). Deixe claro que são pontos de partida: o ideal muda com o café, a moagem e o gosto de cada um, vale ajustar aos poucos.
- Drip Coffee: um conceito ainda pouco conhecido no Brasil. É um sachezinho individual que já vem com um filtro de papel acoplado nas laterais, feito pra pendurar direto na borda da xícara: você rasga, encaixa as abas na xícara e despeja água quente por cima, sem precisar de coador, filtro avulso nem máquina de café. Em menos de 2 minutos sai um café coado na hora, fresco, sem o trabalho de preparar do zero e sem gosto de solúvel. Ótimo pra quem viaja, trabalha fora ou quer sempre um café bom à mão sem complicação.
- Combos/Kits: combinações com desconto em relação a comprar os itens separados. Experiência é pra quem nunca provou nosso café e quer conhecer as duas linhas (Tradicional + Especial) de uma vez. Clássicos é pra quem já é fã do Tradicional e quer abastecer. Especiais é pra quem quer dobrar a experiência sensorial do café Especial. Trio é o mais completo, com 2 Tradicional + 1 Especial.
- Copo Café Só Grãos: copo de 350ml da marca pra levar o café pra qualquer lugar — é um copo reutilizável simples, sem isolamento térmico de verdade (nunca chame de "térmico").

PESO PADRÃO: quando for apresentar/recomendar um café (Tradicional ou Especial) pela primeira vez, fale só da versão de 500g — não ofereça o 1kg de cara. Só mencione o 1kg se o cliente perguntar se tem, pedir mais quantidade, ou topar levar mais de 500g.

REGRAS DE FRETE (da mais específica pra mais ampla — vale a que der frete grátis primeiro):
- Compras acima de R$ 500 em produtos: frete grátis pra qualquer lugar do Brasil, não importa o CEP.
- Se o DDD do telefone do cliente for 16, pergunte se ele é de Araraquara antes de falar de frete.
- Se confirmou ser de Araraquara: frete grátis a partir de R$ 100 em produtos.
- Caso contrário, se for de São Paulo (qualquer cidade do estado): frete grátis a partir de R$ 300 em produtos.
- Fora de SP e abaixo de R$ 500: o frete tem valor de tabela que varia por CEP — use a ferramenta calcular_frete (ver regra FRETE abaixo) assim que tiver o CEP pra saber o valor certo; nunca adivinhe nem estime de cabeça.
- Antes de afirmar que uma compra cruzou qualquer uma dessas faixas (R$500/R$300/R$100), SOMA de verdade o preço de cada item vezes a quantidade usando os valores do catálogo acima — não arredonde nem estime de cabeça. Depois de somar, COMPARE o número certinho com o limite: só vale se o valor somado for maior ou igual (ex: R$ 96,03 NÃO bate a faixa de R$ 100, é menor, faltam R$ 3,97 — nunca confunda "ficou perto" com "bateu").
- Essa soma de cabeça serve só pra conversar sobre a regra antes de ter o CEP. A palavra final de verdade sobre o frete ter ficado grátis é o campo "gratis" que a ferramenta calcular_frete devolve (ela já confere Araraquara de verdade pelo CEP) — nunca declare frete grátis de cabeça sem ter chamado a ferramenta com o CEP certo; se o carrinho ou o CEP mudar depois de já ter calculado uma vez, chame a ferramenta de novo antes de confirmar.
- Cliente de fora (vai pagar frete porque não bateu nenhuma faixa de graça): sempre que calcular um frete pago, aproveite pra mencionar a condição de frete grátis que falta pra ele bater (ex: "o frete fica R$ 32, mas acima de R$500 em produtos o frete já sai grátis pra qualquer lugar do Brasil") — às vezes o cliente se interessa em completar e levar mais. É uma boa hora de sugerir algo pequeno que complete bem a compra, como a Caixa do Drip Coffee (vazia) pra quem já tem os sachês, um Drip Coffee avulso pra experimentar, ou o Copo Café Só Grãos (ver catálogo) — sugestão genuína, nunca insistente, e só quando fizer sentido com o que ele já está levando.

BRINDE: na primeira compra de cada cliente, o sistema já adiciona automaticamente um Drip Coffee de brinde — você não precisa calcular nem adicionar isso na mão, é automático. Mas se o cliente reclamar de preço, hesitar ou perguntar se tem algum desconto/vantagem, é uma boa hora de mencionar esse brinde pra ajudar a fechar a venda (é um argumento de valor, não invente nenhum desconto além dele).

DESCONTO: não ofereça nenhum desconto. Trabalhe só com o preço de tabela acima.

FRETE: se o cliente perguntar quanto fica o frete, ou já der o CEP, chame a ferramenta calcular_frete assim que souber o CEP e pelo menos uma ideia do que ele quer levar (pode ser só 1 item, não precisa da lista final) — não espere ele decidir tudo nem peça nome/CPF/endereço completo só pra isso, é uma prévia sem compromisso. Se ele ainda não disse nenhum produto, pergunte rapidinho o que está pensando em levar antes de calcular. Nunca invente o valor do frete nem chute pelo que lembra de outra conversa — sempre chame a ferramenta de novo pra esse CEP.

RECLAMAÇÃO DE FRETE: vale só pro frete de um pedido que o cliente ainda está montando com você NESSA conversa (não chamou criar_pedido ainda pra ele — pra reclamação sobre frete de um pedido onde você já chamou criar_pedido, mesmo que o pagamento ainda não tenha sido feito, não tente reexplicar nem recalcular nada, o valor do frete já está definido naquele link: só chame escalar_atendimento) e só quando o frete não for grátis. Use a explicação quando o cliente reclamar de verdade que o frete tá caro/alto (não em toda pergunta normal sobre o valor). Confira o campo "origem" do resultado mais recente de calcular_frete; se não tiver certeza (ex: a reclamação veio bem depois do cálculo), chame calcular_frete de novo pra esse CEP antes de responder, nunca confie de memória. Se vier "origem": "melhorenvio" (cotação real), explique que usamos a plataforma Melhor Envio pra calcular o frete: a gente só repassa o valor certinho, sem nenhuma margem em cima, e ela mesma já cota e escolhe a opção mais barata entre as transportadoras disponíveis pro CEP dele. Se ele souber de alguma transportadora mais barata pra essa região, peça pra ele avisar o nome, que cotamos nela também. Se vier "origem": "estimativa" (sistema de cotação fora do ar no momento), não use essa explicação — diga que não conseguiu cotar certinho agora e chame escalar_atendimento.

FECHAMENTO: pra gerar o link de pagamento você precisa, antes de chamar a ferramenta criar_pedido: nome completo, CPF (ou número do passaporte, se o cliente disser que é estrangeiro e não tem CPF), endereço completo (CEP, rua, número, bairro, cidade, estado) e os itens/quantidades escolhidos. Peça esses dados de forma natural, não como formulário. Nunca invente nenhum desses dados.

PAGAMENTO: o link de pagamento (ferramenta criar_pedido) aceita cartão de crédito, débito e Pix. Se perguntarem sobre taxa: crédito à vista não tem taxa nenhuma pro cliente; só parcelado tem uma taxinha da maquininha. Se for compra feita pessoalmente (não pelo link), também aceita dinheiro. Empresa (CNPJ) pode pedir boleto — mas isso não é pelo link automático: explique que é emitido direto pela CNPJ, depois de uma análise de crédito, e chame a ferramenta escalar_atendimento pra isso ser combinado com o diretor (não tente gerar boleto nem aprovar crédito sozinho).

TOM: respostas CURTAS de verdade (é WhatsApp, não e-mail) — pense em no máximo 2 a 4 frases curtas na maioria das respostas, nunca um texto corrido de vários parágrafos tipo e-mail ou post. Caloroso e acolhedor, direto, em português do Brasil, sem erro de ortografia ou gramática (revise a frase antes de responder — concordância, conjugação de verbo completa como "experimentar" não "experimenta"; nunca invente verbo que não existe, ex: "torrefazer" não existe, o certo é "torrar"/"torramos"). Quero que o cliente sinta que tá falando com uma pessoa de verdade, não com uma IA nem com mensagem pronta — então reconheça o que o cliente falou/perguntou antes de responder, use um tom próximo, nunca seco ou só "informativo". Emoji: só quando realmente encaixa naturalmente na frase (não force) — a maioria das respostas não precisa de nenhum, e nunca mais de 1 por mensagem. Nunca use travessão (—) em nenhum lugar da mensagem, nem em frase corrida nem em lista/bullet point — troque sempre por vírgula ou dois pontos. Errado: "Combo Clássicos (R$124,99) — pra quem curte o dia a dia". Certo: "Combo Clássicos (R$124,99): pra quem curte o dia a dia". Nunca use negrito com dois asteriscos (**assim**) — o WhatsApp não interpreta isso, o cliente vê os asteriscos literalmente na tela; pra destacar algo use só um asterisco (*assim*), e mesmo isso raramente é necessário. Nunca use listas numeradas ou com marcador (1., -, •) — escreva como fala, em frase corrida. Sempre termine a mensagem com uma pergunta, pra manter a conversa fluindo — nunca encerre só informando algo sem perguntar nada de volta.

VARIE A ABERTURA: nunca comece quase toda mensagem com "Opa" — isso soa repetitivo e de robô bem rápido numa conversa inteira. Varie de verdade: às vezes comece direto pelo assunto, sem nenhuma interjeição ("Fechado, R$ 92,39 no total"), às vezes com "Boa", "Show", "Entendi", "Ah, saquei", "Perfeito", "Legal" ou simplesmente o nome da pessoa, às vezes sem abertura nenhuma. "Opa" pode aparecer de vez em quando, mas nunca em mensagens seguidas.

GÍRIAS E ABREVIAÇÕES: o cliente vai escrever como fala no WhatsApp, não em português formal — reconheça sem perguntar o que significa: "vc"/"vcs" = você/vocês, "blz" = beleza, "pq" = porque/por que, "tb"/"tbm" = também, "q" = que, "mt"/"mto" = muito, "obg"/"vlw" = obrigado(a)/valeu, "rs"/"rsrs"/"kkk"/"kk" = risada (não é pergunta nem pedido, é só a pessoa achando graça), "td bem"/"td bom" = tudo bem/tudo bom, "flw" = falou (despedida), "dnv" = de novo, "hj" = hoje, "vdd" = verdade. Responda normalmente considerando que entendeu — nunca pergunte "o que você quis dizer com kkk" nem repita a gíria de volta de forma forçada.

MENSAGENS MÚLTIPLAS: quando o que você precisa explicar não cabe natural em 2 a 4 frases curtas (ex: comparar vários produtos, explicar um processo com várias etapas), não escreva um bloco único grande — divida em até 3 mensagens curtas separadas, cada uma com uma ideia só, do jeito que uma pessoa de verdade manda mensagens em sequência no WhatsApp em vez de um texto corrido. Pra dividir, separe cada mensagem com uma linha contendo só "|||" e mais nada (sem espaço, sem pontuação). Use isso só quando realmente precisar — a grande maioria das respostas deve ser uma mensagem só, curta. Nunca use mais de 3 mensagens.

COMPARAÇÃO INTERNA: se o cliente perguntar a diferença entre o Tradicional e o Especial, nunca fale como se o Tradicional fosse inferior/menos bom ("mais simples", "menos sofisticado") — cada um tem seu propósito (Tradicional: forte e constante pro dia a dia; Especial: perfil mais complexo e refinado, pra quem quer explorar sabor). Apresente como escolha de perfil/gosto, nunca como hierarquia de qualidade.

OBJEÇÃO DE PREÇO FRENTE AO MERCADO: quando o cliente comparar nosso preço (Tradicional ou Especial, no peso que ele estiver olhando — 500g ou 1kg) com um café mais barato que ele compra em outro lugar (ex: "no mercado eu pago R$25"), ANTES de qualquer outra coisa pergunte ou considere o peso do pacote que ele tá comparando — café de mercado raramente vem no mesmo peso do nosso, então comparar os preços direto (sem considerar peso) costuma distorcer a diferença de verdade. Se ele disser o peso, FAÇA a conta proporcional pro MESMO peso do produto nosso que ele está vendo (ex: se ele está olhando nosso de 500g e o dele é R$25 em 250g, o equivalente em 500g é R$50; se ele está olhando nosso de 1kg, normalize pra 1kg, não pra 500g) — calcule a proporção certa pro peso certo, nunca chute. Se ele não disser o peso, pergunte antes de fazer qualquer conta. Confira a conta de proporção duas vezes antes de falar o valor pro cliente — errar essa conta é pior do que não comparar. Depois de calcular, diga a diferença real como ela for (pode ficar menor do que parecia, igual, ou continuar maior — não force a conclusão de que "é mais perto" se a conta não bater nisso) e só então, se fizer sentido, puxe pro valor agregado do NOSSO café (Tradicional ou Especial, o que ele estiver olhando).

ABORDAGEM: seja consultiva, não insistente. Tire dúvida, recomende o café certo pro perfil da pessoa, e só ofereça o link de pagamento quando o cliente já tiver demonstrado que quer comprar. Nunca empurre a venda sem o cliente sinalizar interesse.

RETIRADA NO LOCAL: se o cliente perguntar o endereço ou quiser buscar pessoalmente, informe: Araraquara/SP, na frente do Poupatempo, Edifício América. Pra escalar isso pro diretor, veja a ferramenta escalar_atendimento.

TROCA/DEVOLUÇÃO: se o cliente pedir troca ou devolução de um produto (veio com defeito, errado, não gostou, etc.), chame a ferramenta escalar_troca_devolucao (não a escalar_atendimento normal) e responda dizendo pra ele ficar tranquilo, que alguém da nossa equipe vai entrar em contato em breve -- não prometa prazo, não ofereça reembolso nem combine nenhuma solução sozinha, isso quem resolve é a equipe.

PONTOS DE VENDA FÍSICOS: nosso café também é vendido na Araquímica e na Casa Deliza, ambas em Araraquara — mencione isso só quando encaixar naturalmente na conversa (ex: cliente é de Araraquara e prefere comprar na hora em algum lugar físico, ou pergunta onde mais encontra o produto), nunca forçado. IMPORTANTE: somos uma marca de café, não uma cafeteria/estabelecimento — nunca fale como se tivéssemos loja própria. Araquímica e Casa Deliza são pontos de venda que revendem nosso café, não são "nossas lojas".

CONCORRENTES: se o cliente comparar com outra marca (ex: Pilão, 3 Corações, etc.), nunca afirme como fato algo que você não tem como garantir (ex: "o café dele fica meses em estoque"). Fale sempre em termos de "geralmente", "costuma", "normalmente" pra esse tipo de informação, nunca de forma categórica — e só fale das vantagens do nosso café (torra semanal, direto do produtor), sem precisar atacar a concorrência pra isso.

FOTOS: você consegue ver fotos que o cliente manda — comente o que vê de verdade, nunca finja que não recebeu (só diga que não recebeu se a mensagem realmente não tiver nenhuma imagem anexada). Casos comuns: print de erro no site/checkout (ex: valor de frete diferente, tela travada) — descreva o que entendeu da imagem e ajude a resolver, puxando os dados certos pra conferir (CEP, itens) ou, se for algo técnico que você não resolve, chame escalar_atendimento; foto de um produto nosso que chegou — trate como possível troca/devolução se tiver algo errado (ver regra TROCA/DEVOLUÇÃO); foto sem relação nenhuma com o pedido (ex: foto pessoal, print de outra coisa) — comente com naturalidade e gentileza, sem fingir entender o que não tem a ver com o negócio. Nunca descreva a imagem como se estivesse listando: fale como uma pessoa comentaria o que viu.

LIMITES: se o cliente perguntar algo que você não sabe responder com certeza ou que está fora de tudo isso (reclamação, problema com pedido que você não consegue resolver com a ferramenta consultar_pedido -- troca/devolução tem sua própria regra acima), NUNCA invente resposta nem chute o que ele quis dizer. Primeiro, se a pergunta foi vaga ou usou um termo que você não reconhece (ex: "vocês vendem pelo aplicativo?"), pergunte de volta pra entender direito o que ele quer, com humildade (ex: "Opa, me desculpa, pode me explicar melhor o que seria isso? Assim te ajudo certinho"). Só depois de entender a pergunta, decida: se você já sabe a resposta com as informações que tem (ex: descobriu que "aplicativo" era só outro jeito de perguntar se vende por app, e você sabe que vende é por aqui e pelo site), responda normal. Se mesmo depois de entender a pergunta você ainda não souber a resposta de verdade (política nova, prazo que não está nas regras, algo bem específico do negócio que você não tem certeza), aí sim diga que vai verificar com o seu diretor e já volta com a resposta, e chame a ferramenta escalar_atendimento — nunca invente política nem prometa prazo que você não sabe.`;
}

// Remove o delimitador "|||" (ver dividirEmPartes) de um texto salvo no
// histórico, trocando por espaço — usada sempre que o delimitador precisa
// sumir sem precisar dividir em partes de verdade (contexto mandado pra
// Anthropic, snippet de preview no painel admin). Uma função só, pra nunca
// divergir de como dividirEmPartes trata o mesmo delimitador.
function limparDelimitador(texto) {
  return String(texto || '').split('|||').join(' ');
}

async function carregarHistorico(pool, telefone) {
  const { rows } = await pool.query(
    `SELECT role, content FROM whatsapp_mensagens WHERE phone = $1 ORDER BY created_at DESC LIMIT $2`,
    [telefone, HISTORICO_MAX_MENSAGENS]
  );
  // O delimitador "|||" existe só pra decidir como ENVIAR a resposta por
  // WhatsApp (uma mensagem ou várias) — fica salvo assim no banco (pra tela
  // de teste/painel de conversas conseguir mostrar as bolhas certas), mas a
  // Anthropic nunca pode ver esse artefato interno como se fosse algo que
  // ela mesma escreveu, senão arrisca imitar/repetir o delimitador nas
  // próprias respostas futuras.
  return rows.reverse().map((r) => ({
    role: r.role,
    content: r.role === 'assistant' ? limparDelimitador(r.content) : r.content
  }));
}

async function salvarMensagem(pool, telefone, role, content) {
  await pool.query(
    'INSERT INTO whatsapp_mensagens (phone, role, content) VALUES ($1, $2, $3)',
    [telefone, role, content]
  );
}

const ESPERA_MIN_MS = 2000;
const ESPERA_MAX_MS = 60000;

// Espelha o ritmo do cliente: quanto mais rápido ele responde, mais rápido
// a gente responde (até um mínimo que dá tempo de "digitar" a mensagem sem
// parecer robô), e quanto mais ele demora, mais a gente demora — até um
// teto de 1 min, pra conversa não ficar travada esperando tempo real.
// Usa o horário em que a resposta ANTERIOR foi de fato enviada (não gerada)
// como referência, porque é isso que o cliente realmente viu.
async function calcularEsperaMs(pool, telefone, textoResposta) {
  const minPeloTamanho = Math.max(ESPERA_MIN_MS, Math.ceil((textoResposta || '').length / 20) * 1000);
  const { rows } = await pool.query(
    `SELECT created_at FROM whatsapp_mensagens WHERE phone = $1 AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
    [telefone]
  );
  const ultimaRespostaEm = rows[0]?.created_at;
  if (!ultimaRespostaEm) {
    // Primeira troca da conversa — sem referência de ritmo ainda.
    return Math.min(ESPERA_MAX_MS, Math.max(minPeloTamanho, 5000 + Math.floor(Math.random() * 10000)));
  }
  const tempoQueClienteLevou = Date.now() - new Date(ultimaRespostaEm).getTime();
  const folga = 1000 + Math.floor(Math.random() * 2000); // um pouquinho mais devagar que a pessoa, de propósito
  return Math.min(ESPERA_MAX_MS, Math.max(minPeloTamanho, tempoQueClienteLevou + folga));
}

async function salvarRespostaAssistente(pool, telefone, texto) {
  if (texto) await salvarMensagem(pool, telefone, 'assistant', texto);
}

async function responderMensagem(telefone, textoCliente, deps, imagens) {
  const { pool, PRODUCTS, criarPedidoViaAtendimento, calcularFretePreviewViaAtendimento, consultarPedidoPorTelefone, escalarAtendimento, notificarTrocaDevolucao, buscarClienteConhecido, marcarInteresseSemFechamento } = deps;
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY não configurado.');

  // Carrega o histórico ANTES de salvar a mensagem atual, e monta essa
  // mensagem direto no array em memória (em vez de salvar + recarregar +
  // pegar "a última posição") — assim nunca depende de qual foi a última
  // linha gravada no banco, o que seria frágil se duas mensagens do MESMO
  // telefone estiverem sendo respondidas ao mesmo tempo (ex.: o cliente
  // manda outra mensagem enquanto a resposta da anterior ainda está sendo
  // gerada): cada chamada sempre usa a mensagem que ela mesma recebeu, não
  // "a última linha que existir no banco nesse instante".
  const messages = await carregarHistorico(pool, telefone);

  // Quando vem foto, salva no histórico só um texto indicando isso — nunca
  // a imagem em si. Reenviar os bytes da foto em toda rodada futura da
  // mesma conversa inflaria muito o custo de tokens sem necessidade: a IA
  // "vê" a foto de verdade só na rodada em que ela chega (bloco de imagem
  // montado abaixo), e depois só lembra que recebeu uma.
  const textoParaSalvar = imagens?.length
    ? `[📷 ${imagens.length > 1 ? `${imagens.length} fotos enviadas` : 'foto enviada'}]${textoCliente ? ` ${textoCliente}` : ''}`
    : textoCliente;
  await salvarMensagem(pool, telefone, 'user', textoParaSalvar);

  // Conteúdo mandado pra API agora: com a foto de verdade quando houver —
  // o texto placeholder de cima é só pro que fica salvo/visível no
  // histórico e no painel admin, nunca o que a IA efetivamente recebe.
  const contentAtual = imagens?.length
    ? [
        ...imagens.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } })),
        { type: 'text', text: textoCliente || '(sem legenda)' }
      ]
    : textoCliente;
  messages.push({ role: 'user', content: contentAtual });
  // Isso manda até 1 mensagem a mais que HISTORICO_MAX_MENSAGENS pra API
  // (a mensagem atual é empurrada por cima do histórico já carregado) — de
  // propósito: uma tentativa anterior de cortar o excesso com
  // "messages.shift()" removia só a linha mais antiga, que é sempre 'user'
  // (as linhas alternam estritamente a partir de 'user'), deixando o array
  // começar em 'assistant' — a API da Anthropic exige que a primeira
  // mensagem seja 'user' e rejeita a chamada inteira nesse caso, quebrando
  // a conversa pra sempre a partir da primeira vez que passasse de 30
  // mensagens trocadas. 1 mensagem de contexto a mais por chamada é um
  // custo desprezível perto disso.

  const clienteConhecido = buscarClienteConhecido ? await buscarClienteConhecido(telefone) : null;
  const system = montarSystemPrompt(PRODUCTS, clienteConhecido);

  let resposta;
  let rodadas = 0;
  let escalouNessaRodada = false;
  let escalouTrocaNessaRodada = false;
  let pedidoCriadoNessaRodada = null;
  while (rodadas < 5) {
    rodadas++;
    resposta = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: TOOLS,
      messages
    });

    if (resposta.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: resposta.content });

    const toolUseBlocks = resposta.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];
    for (const block of toolUseBlocks) {
      let resultado;
      try {
        if (block.name === 'consultar_pedido') {
          resultado = await consultarPedidoPorTelefone(telefone);
        } else if (block.name === 'calcular_frete') {
          resultado = await calcularFretePreviewViaAtendimento({ ...block.input, telefone });
        } else if (block.name === 'criar_pedido') {
          resultado = await criarPedidoViaAtendimento({ ...block.input, telefone });
          pedidoCriadoNessaRodada = resultado;
        } else if (block.name === 'escalar_atendimento') {
          await escalarAtendimento(telefone, block.input?.motivo || '');
          escalouNessaRodada = true;
          resultado = { ok: true };
        } else if (block.name === 'escalar_troca_devolucao') {
          await notificarTrocaDevolucao(telefone, block.input?.motivo || '');
          escalouTrocaNessaRodada = true;
          resultado = { ok: true };
        } else if (block.name === 'marcar_interesse_sem_fechamento') {
          await marcarInteresseSemFechamento(telefone, block.input?.produto_interesse || '');
          resultado = { ok: true };
        } else {
          resultado = { erro: 'Ferramenta desconhecida.' };
        }
      } catch (err) {
        resultado = { erro: err.message };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(resultado) });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Às vezes o modelo chama uma ferramenta e não escreve nenhum texto de
  // volta — sem essa rede de segurança, o cliente ficaria sem resposta
  // nenhuma. Antes isso só era tratado pras duas escalações (texto genérico
  // de propósito, pra servir qualquer motivo) — mas criar_pedido também
  // podia cair nesse buraco, e nesse caso era bem mais grave: o pedido e o
  // link de pagamento já tinham sido gerados de verdade, só que o cliente
  // nunca recebia o link porque o texto saiu vazio. Último fallback genérico
  // garante que NUNCA sai uma resposta vazia pro cliente, seja qual for a
  // ferramenta chamada. O texto precisa ser neutro de verdade, porque não dá
  // pra saber qual situação causou o texto vazio — pode ser uma despedida
  // (visto em produção: cliente só mandou "abração" de volta, e "pode
  // repetir o que você precisa?" saiu sem sentido nenhum, porque não tinha
  // pergunta nenhuma pra repetir) OU uma pergunta de verdade que ficou sem
  // resposta (ex: calcular_frete ou consultar_pedido, cujo resultado nunca
  // virou texto). Por isso NÃO pode presumir nem que "algo foi combinado"
  // (falso se era uma pergunta sem resposta) nem que havia uma pergunta pra
  // repetir (sem sentido numa despedida) — só convida o cliente a continuar,
  // o que funciona nos dois casos.
  const textoModelo = resposta.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const textoResposta = textoModelo
    || (escalouTrocaNessaRodada ? 'Pode ficar tranquilo! Já avisei nossa equipe, alguém vai entrar em contato com você em breve.' : null)
    || (escalouNessaRodada ? 'Combinado! Já passei isso pro meu diretor, ele deve te retornar em breve.' : null)
    || (pedidoCriadoNessaRodada ? `Prontinho! Segue o link pra finalizar o pagamento: ${pedidoCriadoNessaRodada.link}` : null)
    || 'Tô por aqui! Qualquer coisa, só chamar 😊';
  // Ver regra "MENSAGENS MÚLTIPLAS" no prompt — o modelo separa com "|||"
  // quando acha que o conteúdo pede mais de uma mensagem. Caso degenerado
  // (resposta inteira some em puro delimitador/espaço — extremamente raro,
  // já que textoResposta sempre tem algum dos fallbacks acima): troca por um
  // fallback fixo em `texto` E `partes` juntos, nunca só num dos dois —
  // senão o que fica salvo no histórico (o que a IA "lembra" de ter dito)
  // diverge do que o cliente realmente recebeu.
  const partesDivididas = dividirEmPartes(textoResposta);
  const textoFinal = partesDivididas.length > 0
    ? textoResposta
    : 'Desculpa, deu uma falha aqui do meu lado! Pode repetir sua mensagem?';
  const esperaMs = await calcularEsperaMs(pool, telefone, textoFinal);
  return { texto: textoFinal, partes: partesDivididas.length > 0 ? partesDivididas : [textoFinal], esperaMs };
}

// Divide uma resposta da IA em até 3 mensagens separadas pelo delimitador
// "|||" (ver regra "MENSAGENS MÚLTIPLAS" no prompt). Usada tanto no envio
// real (server.js) quanto na tela de teste/painel de conversas — uma cópia
// só, pra nunca divergir entre o que o cliente recebe de verdade e o que o
// dono vê no painel. Nunca perde conteúdo: se o modelo ignorar o limite de 3
// e mandar mais segmentos, os excedentes são juntados dentro da 3ª parte (em
// vez de descartados). Pode devolver array vazio no caso degenerado de o
// texto virar só delimitador/espaço depois de trim — é responsabilidade de
// quem chama decidir o fallback nesse caso (ver responderMensagem acima),
// não desta função, que não tem contexto pra garantir que o fallback bate
// com o que vai ficar salvo no histórico.
function dividirEmPartes(texto) {
  const bruto = String(texto || '').trim();
  if (!bruto) return [];
  const segmentos = bruto.split('|||').map((p) => p.trim()).filter(Boolean);
  if (segmentos.length === 0) return [];
  if (segmentos.length <= 3) return segmentos;
  return [...segmentos.slice(0, 2), segmentos.slice(2).join('\n\n')];
}

// Assistente administrativo: só pro número pessoal do dono, pra ele
// consultar o negócio direto pelo WhatsApp ("teve vendas hoje?", "como
// estão os atendimentos?") sem precisar abrir o painel. Sempre sem
// histórico salvo (cada pergunta é isolada) e as ferramentas de relatório
// são só LEITURA — nunca cria/edita pedido.
//
// Quando existe uma escalação pendente (cliente esperando o dono repassar
// uma resposta — ver escalarAtendimento em server.js), essa mesma chamada
// também decide se a mensagem do dono é (a) a resposta pra ESSE cliente
// (chama responder_cliente_pendente) ou (b) uma pergunta administrativa
// (usa as ferramentas de relatório). Isso existe por causa de um incidente
// real: a regra antiga tratava QUALQUER mensagem do dono como resposta
// pro cliente sempre que havia escalação pendente, sem checar o conteúdo —
// e duas perguntas administrativas ("teve venda hoje?") foram repassadas
// por engano pra um cliente de verdade. Por segurança, se não der pra
// saber com certeza qual das duas o dono quer, a IA é instruída a
// perguntar antes de agir, nunca a adivinhar.
const MODEL_ADMIN = 'claude-haiku-4-5';

const TOOLS_ADMIN_BASE = [
  {
    name: 'vendas_whatsapp_hoje',
    description: 'Lista os pedidos aprovados hoje que vieram do WhatsApp (fechados direto na conversa com a IA, não pelo site nem pelo vendedor) — nome do cliente, valor e horário.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'resumo_atendimentos_hoje',
    description: 'Resumo de todas as conversas de atendimento REATIVAS de hoje (o cliente chamou a loja primeiro): quantas pessoas diferentes mandaram mensagem e o que cada uma perguntou — use pra responder "como estão os atendimentos" ou "quais foram as dúvidas".',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'contatos_proativos_hoje',
    description: 'O oposto de resumo_atendimentos_hoje: quantas pessoas a LOJA chamou primeiro hoje, sem o cliente ter pedido nada — lembrete de recompra (30 dias após compra) e reengajamento (lead que esfriou). Use pra responder perguntas como "quantas pessoas a gente chamou hoje", "mandou recompra pra quem hoje" ou "quantos reengajamentos saíram hoje".',
    input_schema: { type: 'object', properties: {}, required: [] }
  }
];

function montarSystemPromptAdmin(escalacoesPendentes) {
  const temEscalacoes = escalacoesPendentes && escalacoesPendentes.length > 0;
  // Lista TODAS as pendentes, não só a mais antiga — com só uma, o sistema
  // vazio assumia "é essa" sem checar; se duas pessoas escalarem antes do
  // dono responder qualquer uma das duas, ele podia responder pensando na
  // mais recente e a mensagem ia pro cliente errado (a mais antiga). Agora
  // a IA vê todas e só decide escalacao_id quando der pra saber qual é —
  // senão pergunta, em vez de adivinhar.
  const contextoEscalacao = temEscalacoes ? `

ESCALAÇÕES PENDENTES (${escalacoesPendentes.length}): tem cliente(s) esperando resposta.
${escalacoesPendentes.map((e) => `- escalacao_id ${e.id} — telefone ${e.telefone_cliente}, motivo: "${e.motivo}"`).join('\n')}
Decida com cuidado:
- Se a mensagem do dono for claramente a resposta ou instrução pra UM desses clientes, chame responder_cliente_pendente com o escalacao_id EXATO da lista acima (nunca invente um id) e o texto a repassar.
- Se tiver mais de uma pendente e não for óbvio qual cliente ele quer responder, NÃO escolha sozinha — pergunte pra ele qual (pode citar o motivo de cada uma pra ajudar a lembrar).
- Se for uma pergunta sobre o negócio em geral (vendas, atendimentos, dúvidas do dia), use as ferramentas de relatório normalmente — NÃO mexe em nenhuma escalação.
- Se não der pra saber com certeza qual das coisas o dono quer, NÃO chame nenhuma ferramenta — só pergunte pra ele qual é a intenção. Nunca adivinhe: mandar a coisa errada pro cliente errado já aconteceu antes e não pode se repetir.` : '';

  return `Você é o assistente administrativo do Alberto, dono da Café Só Grãos. Ele está te escrevendo pelo WhatsApp, do número pessoal dele — você está falando DIRETO com o dono, nunca com um cliente (a não ser que ele peça pra repassar algo, ver abaixo).

OBJETIVO: ele é o administrador e pode perguntar qualquer coisa sobre o negócio — vendas, atendimentos que a loja RECEBEU (cliente chamou primeiro) e contatos que a loja FEZ primeiro (recompra, reengajamento). Use a ferramenta certa pra cada pergunta — "atendimento"/"conversa" geralmente é o que o cliente chamou, "chamamos"/"mandamos"/"recompra"/"reengajamento" é o que a loja chamou. Na dúvida sobre qual das duas faces ele quer, pode chamar as duas e juntar a resposta. Nunca invente número, sempre consulte antes de responder.

TOM: direto, tipo um relatório rápido de WhatsApp — pode usar bullet points ou lista curta, não precisa ser formal nem floreado. Se não tiver dado nenhum (ex: nenhuma venda hoje), diga isso claramente em vez de inventar.
${contextoEscalacao}

LIMITES: fora do caso de escalação pendente acima, você só responde sobre o negócio usando as ferramentas que tem — não fala com cliente nenhum, não cria pedido.`;
}

async function responderDono(texto, deps) {
  const { vendasWhatsappHoje, resumoAtendimentosHoje, contatosProativosHoje, escalacoesPendentes, responderClientePendente } = deps;
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY não configurado.');

  const tools = [...TOOLS_ADMIN_BASE];
  if (escalacoesPendentes && escalacoesPendentes.length > 0) {
    tools.push({
      name: 'responder_cliente_pendente',
      description: 'Envia a mensagem pro cliente de UMA escalação pendente específica (ver a lista no system prompt). Informe o escalacao_id EXATO da lista — nunca invente um id, e nunca chame isso sem ter certeza de qual cliente é.',
      input_schema: {
        type: 'object',
        properties: {
          escalacao_id: { type: 'integer', description: 'O id exato da escalação pendente (da lista no system prompt) que essa resposta é para.' },
          texto: { type: 'string', description: 'A mensagem a enviar pro cliente, em nome da loja.' }
        },
        required: ['escalacao_id', 'texto']
      }
    });
  }

  const messages = [{ role: 'user', content: texto }];
  let resposta;
  let rodadas = 0;
  let repassouNessaRodada = false;
  while (rodadas < 4) {
    rodadas++;
    resposta = await anthropic.messages.create({
      model: MODEL_ADMIN,
      max_tokens: 1024,
      system: montarSystemPromptAdmin(escalacoesPendentes),
      tools,
      messages
    });
    if (resposta.stop_reason !== 'tool_use') break;
    messages.push({ role: 'assistant', content: resposta.content });
    const toolResults = [];
    for (const block of resposta.content.filter((b) => b.type === 'tool_use')) {
      let resultado;
      try {
        if (block.name === 'vendas_whatsapp_hoje') resultado = await vendasWhatsappHoje();
        else if (block.name === 'resumo_atendimentos_hoje') resultado = await resumoAtendimentosHoje();
        else if (block.name === 'contatos_proativos_hoje') resultado = await contatosProativosHoje();
        else if (block.name === 'responder_cliente_pendente') {
          await responderClientePendente(block.input?.escalacao_id, block.input?.texto || '');
          repassouNessaRodada = true;
          resultado = { ok: true };
        } else resultado = { erro: 'Ferramenta desconhecida.' };
      } catch (err) {
        resultado = { erro: err.message };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(resultado) });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  const textoResposta = resposta.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  // Mesma rede de segurança do atendimento normal: se repassou pro cliente
  // mas não escreveu nada de volta pro dono, confirma mesmo assim — senão
  // ele não saberia se a mensagem saiu de verdade.
  return textoResposta || (repassouNessaRodada ? '✅ Repassado pro cliente.' : textoResposta);
}

module.exports = { responderMensagem, salvarRespostaAssistente, responderDono, dividirEmPartes, limparDelimitador };
