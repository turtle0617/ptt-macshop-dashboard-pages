(function (root) {
  const products = { macbook: { dataset: 'macbook', label: 'MacBook', filters: ['family','year','chip','storage','memory'], spec: ['family','chip','memory','storage'] }, iphone17: { dataset: 'iphone-17', label: 'iPhone 17', filters: ['model','storage'], spec: ['model','storage'] }, iphone18: { dataset: 'iphone-18', label: 'iPhone 18', filters: ['model','storage'], spec: ['model','storage'] } };
  const fields={family:'family',year:'model_year',chip:'chip',memory:'memory_gb',storage:'storage_gb',model:'model'};
  const scalars=['search','minPrice','maxPrice','dateFrom','dateTo'];
  const modelLabel = value => ({base:'Standard',pro:'Pro','pro-max':'Pro Max',plus:'Plus',air:'Air',e:'e'}[value] || value.split('-').map(word => word[0]?.toUpperCase() + word.slice(1)).join(' '));
  function parseRoute(url, base='/') {
    const prefix=base.endsWith('/')?base:`${base}/`;
    if(!url.pathname.startsWith(prefix))throw Error('Unknown page');
    const key=url.pathname.slice(prefix.length).replace(/\/$/,'')||'macbook';
    const product=products[key];if(!product)throw Error('Unknown product page');
    const filters=Object.fromEntries(product.filters.map(id=>[id,new Set(url.searchParams.getAll(id).filter(Boolean))]));
    for(const id of product.filters.filter(id=>['storage','memory'].includes(id)))for(const v of filters[id])if(!/^\d+$/.test(v)||Number(v)<=0)throw Error(`Invalid ${id}`);
    const scalar=Object.fromEntries(scalars.map(id=>[id,url.searchParams.get(id)||'']));
    for(const id of ['minPrice','maxPrice'])if(scalar[id]&&(!Number.isFinite(Number(scalar[id]))||Number(scalar[id])<0))throw Error('Invalid price');
    if(scalar.minPrice&&scalar.maxPrice&&Number(scalar.minPrice)>Number(scalar.maxPrice))throw Error('Invalid price range');
    for(const id of ['dateFrom','dateTo'])if(scalar[id]&&(!/^\d{4}-\d{2}-\d{2}$/.test(scalar[id])||new Date(`${scalar[id]}T00:00:00Z`).toISOString().slice(0,10)!==scalar[id]))throw Error('Invalid date');
    if(scalar.dateFrom&&scalar.dateTo&&scalar.dateFrom>scalar.dateTo)throw Error('Invalid date range');
    const page=Number(url.searchParams.get('page')||1);if(!Number.isSafeInteger(page)||page<1)throw Error('Invalid page');
    const sortKey=url.searchParams.get('sortKey')||'published_at';
    if(!['published_at','price_ntd','location',...product.filters.map(id=>fields[id])].includes(sortKey))throw Error('Invalid sort');
    const sortDir=url.searchParams.get('sortDir')||'desc';if(!['asc','desc'].includes(sortDir))throw Error('Invalid direction');
    return {key,filters,scalar,page,sortKey,sortDir};
  }
  function serialize(route,base='/') {
    const q=new URLSearchParams();
    for(const id of products[route.key].filters)for(const v of [...(route.filters[id]||[])].sort())q.append(id,v);
    for(const id of scalars)if(route.scalar[id])q.set(id,route.scalar[id]);
    if(route.page>1)q.set('page',route.page);
    if(route.sortKey!=='published_at')q.set('sortKey',route.sortKey);
    if(route.sortDir!=='desc')q.set('sortDir',route.sortDir);
    return `${base.endsWith('/')?base:`${base}/`}${route.key}${q.size?`?${q}`:''}`;
  }
  function matches(row,route,exclude) {
    for(const [id,selected]of Object.entries(route.filters))if(id!==exclude&&selected.size&&!selected.has(String(row[fields[id]])))return false;
    const s=route.scalar;
    return (!s.search||[row.title,row.location,row.family,row.chip,row.model,row.memory_gb,row.storage_gb].join(' ').toLowerCase().includes(s.search.toLowerCase()))&&(!s.minPrice||row.price_ntd>=Number(s.minPrice))&&(!s.maxPrice||row.price_ntd<=Number(s.maxPrice))&&(!s.dateFrom||row.published_at>=s.dateFrom)&&(!s.dateTo||row.published_at<=s.dateTo);
  }
  const api={products,fields,scalars,modelLabel,parseRoute,serialize,matches};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.MacShopSite=api;
})(typeof window!=='undefined'?window:globalThis);
