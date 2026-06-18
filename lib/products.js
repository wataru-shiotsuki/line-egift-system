const supabase = require('./supabase');
let _cache = null;
let _cacheExpiry = 0;
async function getActiveProducts() {
  if (_cache && Date.now() < _cacheExpiry) return _cache;
  const { data, error } = await supabase.from('products').select('*').eq('is_active', true).order('id');
  if (error) throw error;
  _cache = {};
  (data || []).forEach(p => {
    _cache[p.id] = {
      name: p.name,
      amount: p.amount,
      currency: p.currency || 'jpy',
      category: p.category,
      description: p.description || '',
    };
  });
  _cacheExpiry = Date.now() + 60_000;
  return _cache;
}
function invalidateProductsCache() {
  _cache = null;
  _cacheExpiry = 0;
}
module.exports = { getActiveProducts, invalidateProductsCache };