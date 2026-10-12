export function invitationAddress(value: string): { address: string; port: string; baseUrl: string };
export function invitationUrl(address: string, port: string, code: string): string;
export function invitationText(invite: { code: string; baseUrl?: string; link: string }): string;
export function parseInvitation(value: string): { address: string; port: string; baseUrl: string; code: string; groupId?: string; link: string } | null;
