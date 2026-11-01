/**
 * Niños (espacios de datos) a los que accede una cuenta.
 *  - Una cuenta con `dataUid` y/o `dataUids` es un cuidador: accede a esos niños (el primero es el predeterminado).
 *  - Una cuenta sin ninguno de los dos es, ella misma, un niño: accede a su propio espacio.
 */
export function childrenOf(p: { uid: string; dataUid?: string; dataUids?: readonly string[] } | null | undefined): string[] {
  if (!p) return ['local'];
  const list = [...(p.dataUid ? [p.dataUid] : []), ...(p.dataUids ?? [])].filter((x) => typeof x === 'string' && x !== '');
  const uniq = [...new Set(list)];
  return uniq.length ? uniq : [p.uid];
}

/** ¿Es una cuenta de cuidador (comparte datos de otros) y no un niño con datos propios? */
export const isCaregiver = (p: { dataUid?: string; dataUids?: readonly string[] }): boolean => !!p.dataUid || !!p.dataUids?.length;
