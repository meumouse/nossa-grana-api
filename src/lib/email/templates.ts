/**
 * Templates de e-mail transacional. Cada função devolve `{ subject, html, text }`
 * — `text` é o fallback p/ clientes sem HTML e melhora a entregabilidade. O
 * layout é inline-styled de propósito: clientes de e-mail ignoram <style>/CSS
 * externo, então tudo precisa ir no atributo style.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const BRAND = 'Nossa Grana';
const COLOR_PRIMARY = '#16a34a'; // verde — identidade do app

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Envelope visual comum (cabeçalho com a marca + corpo + rodapé). */
function layout(bodyHtml: string): string {
  return `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
            <tr>
              <td style="background:${COLOR_PRIMARY};padding:20px 28px;">
                <span style="color:#ffffff;font-size:18px;font-weight:700;">${BRAND}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;color:#111827;font-size:15px;line-height:1.6;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;line-height:1.5;">
                Você recebeu este e-mail porque há uma conta no ${BRAND} associada a este endereço.
                Se não foi você, pode ignorar esta mensagem com segurança.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Botão de ação (CTA) estilizado inline. */
function button(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:${COLOR_PRIMARY};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px;font-size:15px;">${escapeHtml(
    label,
  )}</a>`;
}

function greeting(name?: string | null): string {
  return name ? `Olá, ${escapeHtml(name)}!` : 'Olá!';
}

export function passwordResetEmail(params: {
  name?: string | null;
  url: string;
  ttlMinutes: number;
}): RenderedEmail {
  const { name, url, ttlMinutes } = params;
  const html = layout(`
    <p style="margin:0 0 16px;">${greeting(name)}</p>
    <p style="margin:0 0 16px;">
      Recebemos um pedido para redefinir a senha da sua conta. Clique no botão
      abaixo para criar uma nova senha:
    </p>
    <p style="margin:0 0 24px;">${button(url, 'Redefinir senha')}</p>
    <p style="margin:0 0 8px;color:#6b7280;font-size:13px;">
      Este link expira em ${ttlMinutes} minutos e só pode ser usado uma vez.
      Se você não pediu a redefinição, ignore este e-mail — sua senha continua a mesma.
    </p>
    <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;word-break:break-all;">
      Ou copie e cole este endereço no navegador:<br/>${escapeHtml(url)}
    </p>
  `);
  const text = `${greeting(name)}

Recebemos um pedido para redefinir a senha da sua conta.
Abra o link abaixo para criar uma nova senha (expira em ${ttlMinutes} minutos, uso único):

${url}

Se você não pediu a redefinição, ignore este e-mail.`;
  return { subject: `Redefinição de senha — ${BRAND}`, html, text };
}

export function verificationEmail(params: {
  name?: string | null;
  url: string;
  ttlHours: number;
}): RenderedEmail {
  const { name, url, ttlHours } = params;
  const html = layout(`
    <p style="margin:0 0 16px;">${greeting(name)}</p>
    <p style="margin:0 0 16px;">
      Falta só um passo: confirme seu endereço de e-mail para ativar todos os
      recursos da sua conta.
    </p>
    <p style="margin:0 0 24px;">${button(url, 'Confirmar e-mail')}</p>
    <p style="margin:0 0 8px;color:#6b7280;font-size:13px;">
      Este link expira em ${ttlHours} horas.
    </p>
    <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;word-break:break-all;">
      Ou copie e cole este endereço no navegador:<br/>${escapeHtml(url)}
    </p>
  `);
  const text = `${greeting(name)}

Confirme seu endereço de e-mail para ativar sua conta.
Abra o link abaixo (expira em ${ttlHours} horas):

${url}`;
  return { subject: `Confirme seu e-mail — ${BRAND}`, html, text };
}

export function invitationEmail(params: {
  inviterName?: string | null;
  workspaceName: string;
  url: string;
  ttlDays: number;
}): RenderedEmail {
  const { inviterName, workspaceName, url, ttlDays } = params;
  const who = inviterName ? escapeHtml(inviterName) : 'Alguém';
  const ws = escapeHtml(workspaceName);
  const html = layout(`
    <p style="margin:0 0 16px;">Olá!</p>
    <p style="margin:0 0 16px;">
      <strong>${who}</strong> convidou você para participar do perfil
      <strong>${ws}</strong> no ${BRAND} e cuidar das finanças em conjunto.
    </p>
    <p style="margin:0 0 24px;">${button(url, 'Aceitar convite')}</p>
    <p style="margin:0 0 8px;color:#6b7280;font-size:13px;">
      Este convite expira em ${ttlDays} dia(s). Se você ainda não tem conta,
      poderá criá-la em seguida com este mesmo e-mail.
    </p>
    <p style="margin:16px 0 0;color:#9ca3af;font-size:12px;word-break:break-all;">
      Ou copie e cole este endereço no navegador:<br/>${escapeHtml(url)}
    </p>
  `);
  const text = `Olá!

${inviterName ?? 'Alguém'} convidou você para participar do perfil "${workspaceName}" no ${BRAND}.
Abra o link abaixo para aceitar (expira em ${ttlDays} dia(s)):

${url}`;
  return { subject: `Convite para "${workspaceName}" — ${BRAND}`, html, text };
}

export function welcomeEmail(params: { name?: string | null; appUrl: string }): RenderedEmail {
  const { name, appUrl } = params;
  const html = layout(`
    <p style="margin:0 0 16px;">${greeting(name)}</p>
    <p style="margin:0 0 16px;">
      Sua conta no ${BRAND} está pronta. A partir de agora você pode organizar
      contas, lançamentos, orçamentos e acompanhar suas finanças num só lugar.
    </p>
    <p style="margin:0 0 24px;">${button(appUrl, 'Abrir o app')}</p>
    <p style="margin:0;color:#6b7280;font-size:13px;">
      Bom controle financeiro! 💚
    </p>
  `);
  const text = `${greeting(name)}

Sua conta no ${BRAND} está pronta. Acesse o app para começar:

${appUrl}

Bom controle financeiro!`;
  return { subject: `Bem-vindo(a) ao ${BRAND}!`, html, text };
}
