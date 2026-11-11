/**
 * Cabeçalho SINTÉTICO no formato que o sincronizador reconhece (não é um arquivo real do programa
 * IRPF): `IRPF`, 4 espaços, exercício, ano-calendário, 4 dígitos de código, 1 de indicador e o CPF.
 */
export function irpfHeader(exerciseYear: number, cpf: string, rest = ''): Buffer {
  const line = `IRPF    ${exerciseYear}${exerciseYear - 1}36000${cpf}   1 MARIA DA SILVA${' '.repeat(40)}${rest}`;
  return Buffer.from(`${line}\r\n01 segunda linha qualquer\r\n`, 'latin1');
}
