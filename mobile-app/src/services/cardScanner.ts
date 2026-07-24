import { BusinessCard } from '../types';
import { apiFetch } from './api';

export async function scanBusinessCard(imageUri: string): Promise<BusinessCard> {
  const response = await fetch(imageUri);
  const blob = await response.blob();
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const b64 = dataUrl.split(',')[1];
      resolve(b64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  const res = await apiFetch('/admin/scan-business-card', {
    method: 'POST',
    body: JSON.stringify({ image: base64 }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to scan business card');
  }

  return res.json();
}
