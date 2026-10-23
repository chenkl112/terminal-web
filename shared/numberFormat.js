const compact = value => value.toFixed(1).replace(/\.0$/, '');

export function formatTokenCount(value) {
  if (value == null) return '—';
  if (value >= 100000000) return `${compact(value / 100000000)} 亿`;
  if (value >= 10000) {
    const tenThousands = Math.round(value / 1000) / 10;
    return tenThousands >= 10000 ? '1 亿' : `${compact(tenThousands)} 万`;
  }
  return new Intl.NumberFormat('zh-CN').format(value);
}
