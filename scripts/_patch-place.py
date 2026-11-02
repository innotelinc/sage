"""One-shot patch: place the version in a submission we control, and name the refusal.

Apple answers a bad submission item with "check associated errors"; the JSON body it
sends back carries more than the one line we print, and a draft it created itself
when the products were submitted may not accept an app version at all.
"""
import io

def load(path):
    raw = io.open(path, encoding='utf-8', newline='').read()
    return raw, ('\r\n' if '\r\n' in raw else '\n')

p = 'scripts/asc-iap.mjs'
raw, nl = load(p)
N = lambda s: s.replace('\n', nl)

# --- 1. diagnose the version's blank fields -----------------------------
old_ready = N("""  line('version state', version.attributes?.appStoreState || 'unknown');""")
assert old_ready in raw, 'readiness tail missing'
new_ready = old_ready + nl + N("""  const full = await soft(`/v1/appStoreVersions/${version.id}?include=build`);
  const attributes = full?.data?.attributes || {};
  const blanks = Object.keys(attributes).filter((name) => attributes[name] === null || attributes[name] === '');
  line('version blanks', blanks.length ? blanks.join(', ') : 'none');""")
raw = raw.replace(old_ready, new_ready, 1)

# --- 2. replace the inline submission block with a real attempt --------
start = raw.find("  try {\n    const subs = await call('GET', `/v1/reviewSubmissions?filter[app]=${app}&limit=10`);")
if start == -1:
    start = raw.find("  try {" + nl + "    const subs = await call('GET', `/v1/reviewSubmissions?filter[app]=${app}&limit=10`);")
assert start != -1, 'submission block start missing'
end_marker = "  console.log(`  screenshots · ${await ensureStoreShots(localization.id)}`);"
assert end_marker not in raw, 'unexpected ordering'

# The block ends with the closing brace of the catch that follows the POST.
tail_marker = "    console.log(`  submission · version not added yet: ${error.message}`);" + nl + "  }" + nl + "}"
tail = raw.find(tail_marker, start)
assert tail != -1, 'submission block tail missing'
block_end = tail + len(tail_marker)
raw = raw[:start] + "  await placeInSubmission(app, version);" + nl + "}" + raw[block_end:]

fns = r'''/**
 * Puts the app version and the three products in one submission.
 *
 * A draft Apple creates on its own — which is what happens when products are
 * submitted through the in-app purchase endpoint — does not necessarily accept an
 * app version, and it answers with a state error that names nothing. So each draft
 * is tried, the raw body is printed when one refuses, and a submission is created
 * here as the fallback, with every item moved across so there is only ever one.
 */
async function placeInSubmission(app, version) {
  const versionItem = (submissionId) => ({
    data: {
      type: 'reviewSubmissionItems',
      relationships: {
        reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
        appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
      },
    },
  });
  const products = await call('GET', `/v1/apps/${app}/inAppPurchasesV2?limit=200`);
  const productIds = (products?.data || []).map((item) => item.id);

  const subs = await call('GET', `/v1/reviewSubmissions?filter[app]=${app}&limit=10`);
  const drafts = (subs?.data || []).filter((item) => item.attributes?.state === 'READY_FOR_REVIEW');

  for (const draft of drafts) {
    try {
      await call('POST', '/v1/reviewSubmissionItems', versionItem(draft.id));
      const items = await call('GET', `/v1/reviewSubmissions/${draft.id}/items?limit=50`);
      console.log(
        `  submission · version ${version.attributes?.versionString} added · ${(items?.data || []).length} items in the draft`,
      );
      return;
    } catch (error) {
      console.log(`  submission · draft ${draft.id} refused the version: ${error.message}`);
      if (error.data) console.log(`  submission · it said: ${JSON.stringify(error.data).slice(0, 900)}`);
    }
  }

  // Build our own draft, then move every item into it.
  let made;
  try {
    made = await call('POST', '/v1/reviewSubmissions', {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: app } } },
      },
    });
  } catch (error) {
    console.log(`  submission · could not create a draft: ${error.message}`);
    if (error.data) console.log(`  submission · it said: ${JSON.stringify(error.data).slice(0, 900)}`);
    return;
  }
  const id = made.data.id;
  console.log(`  submission · new draft ${id} (${made.data.attributes?.state || 'no state'})`);

  for (const draft of drafts) {
    const items = await call('GET', `/v1/reviewSubmissions/${draft.id}/items?limit=50`).catch(() => null);
    for (const item of items?.data || []) {
      try {
        await call('DELETE', `/v1/reviewSubmissionItems/${item.id}`);
      } catch (error) {
        console.log(`  submission · could not clear ${item.id}: ${error.message}`);
      }
    }
  }

  const add = async (relationship, value, type) => {
    try {
      await call('POST', '/v1/reviewSubmissionItems', {
        data: {
          type: 'reviewSubmissionItems',
          relationships: {
            reviewSubmission: { data: { type: 'reviewSubmissions', id } },
            [relationship]: { data: { type, id: value } },
          },
        },
      });
      return true;
    } catch (error) {
      console.log(`  submission · ${relationship} ${value} refused: ${error.message}`);
      if (error.data) console.log(`  submission · it said: ${JSON.stringify(error.data).slice(0, 900)}`);
      return false;
    }
  };

  let placed = false;
  if (await add('appStoreVersion', version.id, 'appStoreVersions')) placed = true;
  for (const productId of productIds) {
    if (await add('inAppPurchase', productId, 'inAppPurchases')) placed = true;
  }
  const items = await call('GET', `/v1/reviewSubmissions/${id}/items?limit=50`).catch(() => null);
  console.log(`  submission · ${(items?.data || []).length} items in draft ${id}${placed ? '' : ' — nothing could be added'}`);
}

'''
anchor = '/** Everything App Review needs, then the version joins the products in the draft. */'
assert anchor in raw, 'listing anchor missing'
if 'async function placeInSubmission(' not in raw:
    raw = raw.replace(anchor, fns.replace('\n', nl) + anchor, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(raw)
print('asc-iap.mjs: submission placement rewritten with real diagnostics')
