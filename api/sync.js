export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  console.log(`\nSYNC STARTED → ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' })}`);

  require('dotenv').config();
  const fs = require('fs');
  const { google } = require('googleapis');
  const { Client } = require('@notionhq/client');

  let credentials;
  try {
    const raw = fs.readFileSync(process.env.GOOGLE_CREDENTIALS_FILE, 'utf8');
    credentials = JSON.parse(raw);
    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  } catch (err) {
    return new Response('Credentials error', { status: 500 });
  }

  const auth = google.auth.fromJSON(credentials);
  auth.scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/contacts'];

  const sheets = google.sheets({ version: 'v4', auth });
  const people = google.people({ version: 'v1', auth });
  const notion = new Client({ auth: process.env.NOTION_TOKEN });

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'Members!A7:C'
    });

    const rows = res.data.values || [];
    if (!rows.length) return new Response('No members', { status: 200 });

    console.log(`Found ${rows.length} members`);

    let existing = [];
    let next_cursor;
    do {
      const r = await notion.databases.query({
        database_id: process.env.NOTION_DB,
        start_cursor: next_cursor,
      });
      existing = existing.concat(r.results);
      next_cursor = r.next_cursor;
    } while (next_cursor);

    const notionMap = new Map();
    existing.forEach(p => {
      const id = p.properties["Member ID"]?.title?.[0]?.text?.content;
      if (id) notionMap.set(id, p.id);
    });

    let created = 0, updated = 0;
    for (const row of rows) {
      const name = row[0]?.trim();
      const phone = row[1]?.trim();
      const id = row[2]?.trim() || "N/A";
      if (!name || !phone || id === "N/A") continue;

      const pageId = notionMap.get(id);
      const properties = {
        "First Name": { rich_text: [{ text: { content: name } }] },
        "Mobile Phone": { phone_number: phone },
        "Member ID": { title: [{ text: { content: id } }] }
      };

      if (pageId) {
        await notion.pages.update({ page_id: pageId, properties });
        updated++;
      } else {
        await notion.pages.create({ parent: { database_id: process.env.NOTION_DB }, properties });
        created++;
      }

      await people.people.createContact({
        requestBody: {
          names: [{ givenName: name.split(' ')[0] || 'Member', familyName: name.split(' ').slice(1).join(' ') || '' }],
          phoneNumbers: [{ value: phone }],
          userDefined: [{ key: 'Member ID', value: id }]
        }
      });
    }

    return new Response(`SYNC DONE! ${rows.length} members (Created: ${created} | Updated: ${updated})`, { status: 200 });
  } catch (err) {
    return new Response(`ERROR: ${err.message}`, { status: 500 });
  }
}