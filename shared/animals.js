// Original courier illustrations. This catalog is shared by Electron and native
// mobile so group identity never depends on the operating system's emoji font.
const ink = '#304E43', outline = '#B1C1AC';
const eyes = '<ellipse cx="24" cy="33" rx="2.1" ry="2.8"/><ellipse cx="40" cy="33" rx="2.1" ry="2.8"/>';
const cheeks = '<ellipse cx="19" cy="39" rx="4" ry="2.3" fill="#ECC4B6"/><ellipse cx="45" cy="39" rx="4" ry="2.3" fill="#ECC4B6"/>';
const smile = '<path d="m29 39 3 2 3-2m-3 2v3" fill="none" stroke="#80685B" stroke-width="1.5"/>';
const entries = [
  ['cat', '小猫', '#F7F5EC', '<path d="M47 51c16 3 15-11 8-12" fill="none" stroke="#DEDCCB" stroke-width="6"/><path d="M14 47c-3-15-1-26 3-36l14 10 15-10c5 11 7 23 3 36Z"/><path d="m18 16 8 7-9 1m27-8-8 7 9 1" fill="#D8BCAF" stroke="none"/>', '<path d="m13 35 7 2m-6 6 7-1m23-5 7-2m-7 7 7 1" stroke="#B1C1AC" stroke-width="1"/>'],
  ['sheep', '绵羊', '#F7F5EB', '<path d="M17 27 8 23c-5 8 2 13 10 12m28-8 10-4c5 8-2 13-10 12" fill="#D9C7B0"/><path d="M14 47c-7-3-7-12-3-15-5-6-1-14 5-15-1-7 8-11 14-7 6-6 14-2 15 4 8-1 13 8 9 13 6 5 4 13-1 15 2 7-3 11-9 10Z"/><ellipse cx="32" cy="34" rx="17" ry="15" fill="#E6D6BE"/><path d="M18 24c-1-6 6-9 10-6 4-6 13-4 15 2 6-2 9 3 7 6"/>', ''],
  ['monkey', '小猴', '#BA9270', '<circle cx="11" cy="31" r="9"/><circle cx="53" cy="31" r="9"/><circle cx="11" cy="31" r="5" fill="#EED9B8" stroke="none"/><circle cx="53" cy="31" r="5" fill="#EED9B8" stroke="none"/><path d="M15 46V27c0-20 34-21 34 0v19Z"/><path d="M32 24c-13-15-26 3-15 16 6 12 24 12 30 0 10-13-2-31-15-16Z" fill="#F1DFC5"/><path d="M25 12c1-6 12-9 15-2" fill="none" stroke="#9B7658" stroke-width="3"/>', ''],
  ['dog', '小狗', '#EBD4AA', '<path d="M18 16C6 13 4 27 8 42c1 5 9 5 12-3m26-23c12-3 14 11 10 26-1 5-9 5-12-3" fill="#B99875"/><path d="M14 46V29c0-23 36-23 36 0v17Z"/><ellipse cx="32" cy="39" rx="12" ry="9" fill="#FAF2DD" stroke="none"/>', '<path d="m29 37 3 3 3-3Z" fill="#80685B" stroke="none"/>'],
  ['chick', '小鸡', '#F4D681', '<path d="M26 17c-8-13 1-15 5-5 0-12 10-12 8 2 8-8 13-3 5 5" fill="#E8AA83"/><path d="M11 49V34c0-26 42-26 42 0v15Z"/><path d="M14 39c-8 1-12 7-8 12l13-3m31-9c8 1 12 7 8 12l-13-3" fill="#EAC267"/>', '<path d="m26 39 6-4 6 4-6 5Z" fill="#DB9E60" stroke="#C68C50"/>'],
  ['lizard', '小蜥蜴', '#A8CF96', '<path d="M46 53c14 1 16-12 8-17 2 8-3 11-9 8" fill="#86B87A"/><path d="m19 22-5-9 10 5m9 0 6-10 5 12" fill="#D9E6A9"/><path d="M11 45V30c0-8 7-13 14-12 6-4 19-2 25 6 5 5 6 13 3 21Z"/><ellipse cx="24" cy="30" rx="7" ry="8" fill="#EFF5DA"/><ellipse cx="40" cy="30" rx="7" ry="8" fill="#EFF5DA"/>', '<path d="M24 42q8 6 16 0" stroke="#5D8754" fill="none"/><circle cx="49" cy="41" r="2" fill="#7EAC6A" stroke="none"/>'],
  ['alpaca', '羊驼', '#F0E6CE', '<path d="M19 22c-7-17-3-22 2-15l5 15m12 0 5-15c5-7 9-2 2 15"/><path d="M18 52V31c-9-7-5-15 2-15 3-6 12-6 16-2 6-4 14 1 14 7 7 4 6 13-4 15v16Z"/><ellipse cx="32" cy="37" rx="12" ry="10" fill="#FAF5E8" stroke="none"/><path d="M18 25c3-4 8-5 11-2 2-5 10-6 14-1" fill="none"/>', '<path d="m29 37 3 2 3-2" fill="none" stroke="#80685B" stroke-width="1.5"/>'],
  ['rabbit', '小兔', '#F3EDE5', '<path d="M18 26C9-2 26-6 27 23m10 0C38-6 55-2 46 26"/><path d="M20 20c-4-16 3-19 4 0m16 0c1-19 8-16 4 0" fill="#DDBDAF" stroke="none"/><path d="M12 46V35c0-24 40-24 40 0v11Z"/>', ''],
  ['otter', '水獭', '#BE9E7B', '<circle cx="15" cy="19" r="6"/><circle cx="49" cy="19" r="6"/><path d="M12 48V32c0-25 40-25 40 0v16Z"/><ellipse cx="32" cy="39" rx="17" ry="12" fill="#EDDEC5" stroke="none"/>', '<ellipse cx="32" cy="38" rx="4" ry="2.5" fill="#80685B" stroke="none"/><path d="m12 38 8 1m-8 6 8-2m24-4 8-1m-8 5 8 2" stroke="#967A5F" stroke-width="1"/>'],
  ['capybara', '卡皮巴拉', '#CBB392', '<circle cx="17" cy="17" r="6"/><circle cx="46" cy="17" r="6"/><path d="M11 48V31c0-8 4-16 14-16h15c10 0 14 8 14 16v17Z"/><rect x="19" y="31" width="33" height="17" rx="8" fill="#DFC9A7" stroke="none"/>', '<path d="M22 32h6m10 0h6" stroke="#304E43" stroke-width="2"/><path d="M31 41h8" stroke="#80685B" stroke-width="1.5"/>'],
];
export const ANIMALS = entries.map(([id, name]) => ({ id, name }));
export const isAnimalId = id => ANIMALS.some(animal => animal.id === id);
export function groupAnimal(group) {
  if (isAnimalId(group?.animalId)) return group.animalId;
  let hash = 0; for (const char of String(group?.id || '')) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return ANIMALS[hash % ANIMALS.length].id;
}
export function nextAnimal(groups = []) {
  const used = new Set(groups.map(groupAnimal));
  return (ANIMALS.find(animal => !used.has(animal.id)) || ANIMALS[groups.length % ANIMALS.length]).id;
}
export function animalSvg(id) {
  const [, , fur, head, detail] = entries.find(entry => entry[0] === id) || entries[0];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><g stroke="${outline}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><g fill="${fur}">${head}</g><g fill="${ink}" stroke="none">${id === 'capybara' ? '' : eyes}</g>${cheeks}${id === 'chick' || id === 'capybara' || id === 'lizard' ? '' : smile}${detail}<rect x="18" y="46" width="28" height="16" rx="4" fill="#126A5A" stroke="#126A5A"/><path d="m20 48 12 8 12-8" stroke="#9CE3CA"/><path d="M32 55v6" stroke="#66C6A7"/><ellipse cx="17" cy="49" rx="5" ry="6" fill="${fur}"/><ellipse cx="47" cy="49" rx="5" ry="6" fill="${fur}"/></g></svg>`;
}
