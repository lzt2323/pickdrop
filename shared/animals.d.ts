export const ANIMALS: Array<{ id: string; name: string }>;
export function isAnimalId(id: unknown): boolean;
export function groupAnimal(group?: { id?: string; animalId?: string } | null): string;
export function nextAnimal(groups?: Array<{ id?: string; animalId?: string }>): string;
export function animalSvg(id: string): string;
