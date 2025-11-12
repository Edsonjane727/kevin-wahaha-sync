export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  console.log(`\nFULL SYNC STARTED → ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' })}`);

  // === YOUR FULL CODE BELOW (paste everything from require('dotenv') down to the end) ===
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
    console.error('Credentials error:', err.message);
    return new Response('Credentials error', { status: 500 });
  }

  const auth = google.auth.fromJSON(credentials);
  auth.scopes = [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/contacts'
  ];

  const sheets = google.sheets({ version: 'v4', auth });
  const people = google.people({ version: 'v1', auth });
  const notion = new Client({ auth: process.env.NOTION_TOKEN });

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'Members!A7:C'
    });

    const rows = res.data.values || [];
    if (!rows.length) {
      console.log('No members found.');
      return new Response('SYNC DONE — No members', { status: 200 });
    }

    console.log(`Found ${rows.length} members in Google Sheet`);

    // === REST OF YOUR ORIGINAL CODE (Notion query, map, loop, etc.) ===
    let existing = [];
    let next_cursor = undefined;
    do {
      const response = await notion.databases.query({
        database_id: process.env.NOTION_DB,
        start_cursor: next_cursor,
      });
      existing = existing.concat(response.results);
      next_cursor = response.next_cursor;
    } while (next_cursor);

    const notionMap = new Map();
    existing.forEach(page => {
      const id = page.properties["Member ID"]?.title?.[0]?.text?.content;
      if (id) notionMap.set(id, page.id);
    });

    let updated = 0, created = 0;

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

      try {
        if (pageId) {
          await notion.pages.update({ page_id: pageId, properties });
          console.log(`Updated → ${name} (ID: ${id})`);
          updated++;
        } else {
          await notion.pages.create({
            parent: { database_id: process.env.NOTION_DB },
            properties
          });
          console.log(`Created → ${name} (ID: ${id})`);
          created++;
        }
      } catch (e) {
        console.log(`Notion error → ${name}: ${e.message}`);
      }

      try {
        await people.people.createContact({
          requestBody: {
            names: [{ givenName: name.split(' ')[0] || 'Member', familyName: name.split(' ').slice(1).join(' ') || '' }],
            phoneNumbers: [{ value: phone }],
            userDefined: [{ key: 'Member ID', value: id }]
          }
        });
        console.log(`Contact added → ${name}`);
      } catch (e) {}
    }

    console.log(`\nSYNC DONE! Updated: ${updated} | Created: ${created} | Total: ${rows.length}`);
    return new Response(`SYNC DONE! ${rows.length} members processed`, { status: 200 });

  } catch (err) {
    console.error("SYNC FAILED:", err.message);
    return new Response(`ERROR: ${err.message}`, { status: 500 });
  }
}