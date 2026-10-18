// Cheapest mart items that restore a party after a battle (CHARTER.md v1:
// Elite Four between-battle healing). Prices, heal amounts and mart tiers come
// from config/bag-items.hgss.json (pret item_data.csv / scrcmd_mart.c).

import BAG_ITEMS from '../config/bag-items.hgss.json' with { type: 'json' };

const ITEMS = BAG_ITEMS.items;

export function martItemsForBadges(badges) {
  const tiers = BAG_ITEMS.tierByBadgeCount;
  const tier = tiers[Math.min(Math.max(0, badges), tiers.length - 1)];
  return Object.keys(ITEMS).filter(name => ITEMS[name].tier <= tier);
}

// Minimum shop cost to restore `deficit` HP with the available potions.
// Unbounded knapsack over fixed-HP potions; "full" potions cover any deficit.
function cheapestHpRestore(deficit, available) {
  if (deficit <= 0) return { cost: 0, items: {} };
  const fixed = available
    .filter(name => Number(ITEMS[name].healHp) > 0)
    .map(name => ({ name, heal: Number(ITEMS[name].healHp), price: ITEMS[name].price }));
  const full = available
    .filter(name => ITEMS[name].healHp === 'full' && !ITEMS[name].cures)
    .map(name => ({ name, price: ITEMS[name].price }))
    .sort((a, b) => a.price - b.price)[0] || null;
  const best = new Array(deficit + 1).fill(Infinity);
  const pick = new Array(deficit + 1).fill(null);
  best[0] = 0;
  for (let hp = 1; hp <= deficit; hp += 1) {
    for (const potion of fixed) {
      const cost = potion.price + best[Math.max(0, hp - potion.heal)];
      if (cost < best[hp]) {
        best[hp] = cost;
        pick[hp] = potion;
      }
    }
  }
  if (full && full.price < best[deficit]) return { cost: full.price, items: { [full.name]: 1 } };
  if (!Number.isFinite(best[deficit])) return null;
  const items = {};
  for (let hp = deficit; hp > 0; hp = Math.max(0, hp - pick[hp].heal)) {
    items[pick[hp].name] = (items[pick[hp].name] || 0) + 1;
  }
  return { cost: best[deficit], items };
}

function cheapestStatusCure(status, available) {
  if (!status) return { cost: 0, items: {} };
  const options = available
    .filter(name => ITEMS[name].cures?.includes(status) && !ITEMS[name].healHp)
    .sort((a, b) => ITEMS[a].price - ITEMS[b].price || a.localeCompare(b));
  if (!options.length) return null;
  return { cost: ITEMS[options[0]].price, items: { [options[0]]: 1 } };
}

const addItems = (...lists) => {
  const merged = {};
  for (const list of lists) {
    for (const [name, count] of Object.entries(list || {})) merged[name] = (merged[name] || 0) + count;
  }
  return merged;
};

// mon: { hp, maxhp, status, fainted }. Returns { cost, items } or null when the
// available items cannot restore it.
export function cheapestRestore(mon, available) {
  const maxhp = Math.max(1, Number(mon.maxhp || 1));
  let hp = Math.max(0, Number(mon.hp || 0));
  let status = mon.fainted || hp === 0 ? '' : String(mon.status || '');
  let base = { cost: 0, items: {} };
  if (mon.fainted || hp === 0) {
    if (!available.includes('Revive')) return null;
    base = { cost: ITEMS.Revive.price, items: { Revive: 1 } };
    hp = Math.floor(maxhp / 2);
  }
  const deficit = maxhp - hp;
  const separate = (() => {
    const heal = cheapestHpRestore(deficit, available);
    const cure = cheapestStatusCure(status, available);
    if (!heal || !cure) return null;
    return { cost: heal.cost + cure.cost, items: addItems(heal.items, cure.items) };
  })();
  const restoreAll = available
    .filter(name => ITEMS[name].healHp === 'full' && ITEMS[name].cures)
    .sort((a, b) => ITEMS[a].price - ITEMS[b].price)[0];
  let best = separate;
  if (restoreAll && (deficit > 0 || status) && (!best || ITEMS[restoreAll].price < best.cost)) {
    best = { cost: ITEMS[restoreAll].price, items: { [restoreAll]: 1 } };
  }
  if (!best) return null;
  return { cost: base.cost + best.cost, items: addItems(base.items, best.items) };
}

export function cheapestPartyRestore(party, available) {
  let cost = 0;
  let items = {};
  for (const mon of party || []) {
    const restore = cheapestRestore(mon, available);
    if (!restore) return null;
    cost += restore.cost;
    items = addItems(items, restore.items);
  }
  return { cost, items };
}
