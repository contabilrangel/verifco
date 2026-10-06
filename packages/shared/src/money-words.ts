/**
 * Valor em reais por extenso, usado em recibos.
 * Ex.: 123456 centavos → "mil duzentos e trinta e quatro reais e cinquenta e seis centavos".
 */
const UNITS = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const HUNDREDS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

/** Número de 0 a 999 por extenso (0 → ''). */
function hundreds(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'cem';
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h) parts.push(HUNDREDS[h]);
  if (rest) {
    if (rest < 20) parts.push(UNITS[rest]);
    else {
      const t = Math.floor(rest / 10);
      const u = rest % 10;
      parts.push(u ? `${TENS[t]} e ${UNITS[u]}` : TENS[t]);
    }
  }
  return parts.join(' e ');
}

const SCALES: [string, string][] = [
  ['', ''],
  ['mil', 'mil'],
  ['milhão', 'milhões'],
  ['bilhão', 'bilhões'],
  ['trilhão', 'trilhões'],
];

/** Inteiro não negativo por extenso (0 → "zero"). */
export function integerInWords(value: number): string {
  let n = Math.floor(Math.abs(value));
  if (n === 0) return 'zero';
  const groups: number[] = [];
  while (n > 0) {
    groups.push(n % 1000);
    n = Math.floor(n / 1000);
  }
  if (groups.length > SCALES.length) throw new Error('Valor grande demais para escrever por extenso.');
  const pieces: { text: string; group: number }[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (!g) continue;
    let text: string;
    if (i === 0) text = hundreds(g);
    else if (i === 1) text = g === 1 ? 'mil' : `${hundreds(g)} mil`;
    else text = `${hundreds(g)} ${g === 1 ? SCALES[i][0] : SCALES[i][1]}`;
    pieces.push({ text, group: g });
  }
  // o último grupo leva "e" quando é menor que 100 ou centena exata (ex.: "mil e cem", "mil e vinte")
  return pieces
    .map((p, idx) => {
      if (idx === 0) return p.text;
      const isLast = idx === pieces.length - 1;
      const joinE = isLast && (p.group < 100 || p.group % 100 === 0);
      return `${joinE ? ' e ' : ' '}${p.text}`;
    })
    .join('');
}

/** Valor em centavos por extenso em reais. */
export function amountInWords(cents: number): string {
  const total = Math.round(Math.abs(cents));
  const reais = Math.floor(total / 100);
  const centavos = total % 100;
  const parts: string[] = [];
  if (reais > 0) {
    const words = integerInWords(reais);
    // "um milhão de reais", "dois milhões de reais"
    const de = reais % 1_000_000 === 0 ? ' de' : '';
    parts.push(`${words}${de} ${reais === 1 ? 'real' : 'reais'}`);
  }
  if (centavos > 0) parts.push(`${integerInWords(centavos)} ${centavos === 1 ? 'centavo' : 'centavos'}`);
  if (!parts.length) return 'zero real';
  return parts.join(' e ');
}
