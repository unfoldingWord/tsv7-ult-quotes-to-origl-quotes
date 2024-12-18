import axios from 'axios';
import xregexp from 'xregexp';
import { Proskomma } from 'proskomma';

import { BibleBookData } from '../common/books';
import { parseTsvToObjects, tsvRecordToString } from '../utils/tsv';
import { rejigAlignment } from '../utils/rejig_alignment';
import { slimSourceTokens } from '../utils/tokens';

const pk = new Proskomma([
  {
    name: 'org',
    type: 'string',
    regex: '^[^\\s]+$',
  },
  {
    name: 'lang',
    type: 'string',
    regex: '^[^\\s]+$',
  },
  {
    name: 'abbr',
    type: 'string',
    regex: '^[A-za-z0-9_-]+$',
  },
]);
let tokenLookup = {};
const importedBooks = [];

// Adapted from https://github.com/unfoldingWord-box3/uw-proskomma/blob/main/src/utils/download.js May 2021
const getDocuments = async (book, dcsUrl = 'https://git.door43.org') => {
  book = book.toLowerCase();

  if (importedBooks.includes(book)) {
    return;
  }

  const ol_bible = BibleBookData?.[book]?.testament === 'old' ? 'hbo_uhb' : 'el-x-koine_ugnt';
  if (!ol_bible) {
    console.error(`ERROR: Book ${book} not a valid Bible book`);
    return;
  }
  const baseURLs = [
    ['unfoldingWord', ...ol_bible.split('_'), `${dcsUrl}/api/v1/repos/unfoldingWord/${ol_bible}/contents/${BibleBookData[book].usfm}.usfm`],
    ['unfoldingWord', 'en', 'ult', `${dcsUrl}/api/v1/repos/unfoldingWord/en_ult/contents/${BibleBookData[book].usfm}.usfm`],
  ];
  // console.log('Download USFM');
  for (const [org, lang, abbr, baseURL] of baseURLs) {
    const selectors = {
      org,
      lang,
      abbr,
    };
    // console.log(`  ${org}/${lang}/${abbr}`);
    let content = [];
    await axios.request({ method: 'get', url: baseURL }).then(async (response) => {
      const decodedContent = Buffer.from(response.data.content, 'base64').toString('utf-8');
      content.push(decodedContent);
    });
    if (content.length === 0) {
      // console.log(`      Book ${book} not found`);
      continue;
    }
    // console.log(`      Downloaded ${book} ${content.length.toLocaleString()} bytes`);

    const startTime = Date.now();
    if (abbr === 'ult') {
      content = [rejigAlignment(content)]; // Tidy-up ULT USFM alignment info
    }
    try {
      pk.importDocuments(selectors, 'usfm', content, {});
    } catch (err) {
      if (!err.message.includes('already exists in docSet')) {
        console.error(`ERROR: ${err}`);
      }
    }
    // console.log(`      Imported in ${Date.now() - startTime} msec`);
  }
  importedBooks.push(book);
  return;
};

// Adapted from https://github.com/unfoldingWord-box3/uw-proskomma/blob/main/src/utils/query.js May 2021
// Called from main
const doAlignmentQuery = async () => {
  const query =
    '{' +
    'docSets {' +
    '  abbr: selector(id:"abbr")' +
    '  documents {' +
    '    book: header(id:"bookCode")' +
    '    mainSequence {' +
    '      itemGroups (' +
    '        byScopes:["chapter/", "verses/"]' +
    '      ) {' +
    '        scopeLabels' +
    '        tokens {' +
    '          subType' +
    '          payload' +
    '          position' +
    '          scopes(startsWith:"attribute/milestone/zaln/x-align")' + // This line was changed (and assumes preprocessing of alignment info)
    '        }' +
    '      }' +
    '    }' +
    '  }' +
    '}' +
    '}';
  const result = await pk.gqlQuery(query);
  if (result.errors) {
    throw new Error(result.errors);
  }
  tokenLookup = {};
  for (const docSet of result.data.docSets) {
    tokenLookup[docSet.abbr] = {};
    for (const document of docSet.documents) {
      tokenLookup[docSet.abbr][document.book] = {};
      for (const itemGroup of document.mainSequence.itemGroups) {
        const chapter = itemGroup.scopeLabels.filter((s) => s.startsWith('chapter/'))[0].split('/')[1];
        for (const verse of itemGroup.scopeLabels
          .filter((s) => s.startsWith('verses/'))[0]
          .split('/')[1]
          .split('-')) {
          const cv = `${chapter}:${verse}`;
          tokenLookup[docSet.abbr][document.book][cv] = itemGroup.tokens;
        }
      }
    }
  }
};

// Adapted from https://github.com/unfoldingWord-box3/uw-proskomma/blob/main/src/utils/search.js May 2021
// Called from origLFromGLQuote()
/**
 *
 * @param {string} ULTSearchString -- the string of ULT words being searched for (may include ellipsis)
 * @param {Array} ULTTokens -- ULT token objects with two fields: payload = ULT word; scopes = info about aligned OrigL word(s)
 * @returns a list of 3-tuples with (ULTWord, flag if ULTWord follows an ellipsis, scopes array)
 */
const searchULTWordRecords = (ULTSearchString, ULTTokens) => {
  // console.log(`searchULTWordRecords('${ULTSearchString}', (${ULTTokens.length}), ${JSON.stringify(ULTTokens)})…`);

  // Break the search string into a list of words, and determine if they're contiguous (why do we even need that?)
  const ret = [];
  for (let searchExpr of xregexp.split(ULTSearchString, /[-\s־]/)) {
    // includes hyphen (beautiful-looking and maqaf)
    // console.log(`    searchULTWordRecords processing searchExpr='${searchExpr}'`);
    // The ULT "sourceTokens" have all punctuation (incl. word punctuation) as separate tokens!
    // So remove sentence punctuation (incl. all apostrophes!) from our individual search words
    // Added 'all' scope flag below to handle words with multiple punctuation marks to be removed, e.g. "(word),"
    searchExpr = xregexp.replace(searchExpr, /["'“‘”’{}(),?:;.!]/, '', 'all'); // Added colon and parentheses
    if (searchExpr.includes('…')) {
      const searchExprParts = searchExpr.split('…');
      ret.push([searchExprParts[0], false]);
      searchExprParts.slice(1).forEach((p) => ret.push([p, true]));
    } else {
      ret.push([searchExpr, false]);
    }
  }
  const intermediateSearchList = ret.filter((t) => t[0] !== '׀'); // why is this needed -- ah for \w fields maybe -- still not really sure ???
  // console.log(`  searchULTWordRecords intermediateSearchList=${intermediateSearchList}`);
  // Now intermediateSearchList is a list of two-tuples being search word, and ellipsis flag

  // Now match the search words against the ULT tokens and get the alignment information (scopes field)
  function getFirstWordIndex(searchWord, ULTTokenList, startAt) {
    while (startAt < ULTTokenList.length) {
      if (ULTTokenList[startAt].payload === searchWord) return startAt;
      ++startAt;
    }
    return -1;
  }
  let startULTIndex = 0,
    foundAllWords = false;
  while ((startULTIndex = getFirstWordIndex(intermediateSearchList[0][0], ULTTokens, startULTIndex)) !== -1) {
    // console.log(`    searchULTWordRecords found first word '${intermediateSearchList[0][0]}' at ${startULTIndex} in ${JSON.stringify(ULTTokens)}`);
    foundAllWords = true;
    let searchIndex = 1,
      ultIndex = startULTIndex + 1;
    while (ultIndex < ULTTokens.length && searchIndex < intermediateSearchList.length)
      if (ULTTokens[ultIndex++].payload !== intermediateSearchList[searchIndex++][0]) {
        foundAllWords = false;
        break;
      }
    if (foundAllWords) break;
    ++startULTIndex;
  }
  if (!foundAllWords) {
    console.error(`ERROR: searchULTWordRecords couldn't find ${intermediateSearchList} in ${JSON.stringify(ULTTokens.map((t) => t.payload))}`);
    return [];
  }
  // console.log(`  searchULTWordRecords found ${intermediateSearchList} starting at ${startULTIndex}`);

  // Now we just have to add the scopes field to the list of two-tuples
  let searchIndex = 0;
  while (startULTIndex < ULTTokens.length && searchIndex < intermediateSearchList.length) intermediateSearchList[searchIndex++].push(ULTTokens[startULTIndex++].scopes); // Appends the scopes field (after word and ellipsis flag)
  // console.log(`  searchULTWordRecords returning ${intermediateSearchList}`);
  return intermediateSearchList;
};

// Adapted from https://github.com/unfoldingWord-box3/uw-proskomma/blob/main/src/utils/search.js#L53 May 2021
// Called from main
/**
 *
 * @param {string} book
 * @param {string} cv
 * @param {Array} sourceTokens
 * @param {Array} ULTTokens
 * @param {string} ULTSearchString
 * @param {bool} prune
 * @returns
 */
const origLFromGLQuote = (book, cv, sourceTokens, ULTTokens, ULTSearchString, searchOccurrence, prune) => {
  // console.log(`origLFromGLQuote(${book}, ${cv}, (${sourceTokens.length}), (${ULTTokens.length}), '${ULTSearchString}', searchOccurrence=${searchOccurrence}, prune=${prune})…`);
  const ULTSearchThreeTuples = searchULTWordRecords(ULTSearchString, ULTTokens); // 0: ULT word, 1: followsEllipsisFlag, 2: alignment scopes array
  // console.log(`  ULTSearchThreeTuples = (${ULTSearchThreeTuples.length}) ${JSON.stringify(ULTSearchThreeTuples)}`);
  // NOTE: We lose the Greek apostrophes (e.g., from κατ’) in the next line
  const wordLikeOrigLTokens = slimSourceTokens(sourceTokens.filter((t) => t.subType === 'wordLike')); // drop out punctuation, space, eol, etc., tokens
  // console.log(`\n  wordLikeOrigLTokens = (${wordLikeOrigLTokens.length}) ${JSON.stringify(wordLikeOrigLTokens)}`); // The length of this list is now the number of Greek words in the verse
  const origLWordList = wordLikeOrigLTokens.map((t) => t.payload);
  // console.log(`\n  origLWordList = (${origLWordList.length}) ${origLWordList}`); // The length of this list is now the number of Greek words in the verse

  // Now we go through in the order of the original language words, to get the ones that match
  const origLQuoteWords = [];
  for (const origLWord of origLWordList) {
    // console.log(`  origLFromGLQuote checking origL word '${origLWord}'`);
    const searchOrigLWord = `/${origLWord}:`;
    for (const ULTSearchThreeTuple of ULTSearchThreeTuples) {
      // console.log(`   origLFromGLQuote have ULTSearchThreeTuple=${ULTSearchThreeTuple}`);
      const scopesArray = ULTSearchThreeTuple[2];
      // console.log(`    origLFromGLQuote looking for scopes ${scopesArray} for '${ULTSearchThreeTuple[0]}'`);
      if (scopesArray?.length === 1) {
        if (scopesArray[0].indexOf(searchOrigLWord) !== -1) {
          origLQuoteWords.push(origLWord); // Might get the same word more than once???
          break;
        }
      } else if (scopesArray?.length === 2) {
        if (scopesArray[0].indexOf(searchOrigLWord) !== -1 || scopesArray[1].indexOf(searchOrigLWord) !== -1) {
          origLQuoteWords.push(origLWord); // Might get the same word more than once???
          break;
        }
      } else console.error(`WARNING: origLFromGLQuote code not written for ${scopesArray?.length} scopes entries: searching for '${origLWord}' in ${ULTSearchThreeTuple}`);
    }
  }
  // console.log(`  origLFromGLQuote got result (${origLQuoteWords.length}) ${origLQuoteWords}`);
  if (origLQuoteWords.length === 0)
    return {
      error:
        // `EMPTY MATCH IN SOURCE\nSearch Tuples: ${JSON.stringify(searchTuples)}\nCodepoints: ${searchTuples.map(s => "|" + Array.from(s[0]).map(c => c.charCodeAt(0).toString(16)))}`
        `EMPTY MATCH IN OrigL SOURCE\n    Search String: ${book} ${cv} '${ULTSearchString}' occurrence=${searchOccurrence}\n      from ULTTokens (${
          ULTTokens.length
        }) ${JSON.stringify(ULTTokens)}\n       then ULTSearchThreeTuples (${ULTSearchThreeTuples.length}) ${ULTSearchThreeTuples}\n       then wordLikeOrigLTokens (${
          wordLikeOrigLTokens.length
        }) ${JSON.stringify(wordLikeOrigLTokens)}`,
    };
  // else have some origLQuoteWords
  // console.log(`  origLFromGLQuote returning (${origLQuoteWords.length}) ${origLQuoteWords}`);
  return { data: origLQuoteWords };
};

// Called from main
/**
 *
 * @param {Array} wordList
 * @description Converts list to string and tidies it
 * @returns a tidyied string with the matching OrigL words
 */
const getTidiedData = (wordList) => {
  // console.log(`getTidiedData((${wordList.length}) ${wordList})…`);

  const tidiedDataString = wordList.join(' ').replace(/\s*…\s*/, ' & ');
  // console.log(`  Returning '${tidiedDataString}'`);
  return tidiedDataString;
};

const prune = true; // only return the matching quote -- not the entire verse text

const containsHebrewOrGreek = (text) => /[\u0590-\u05FF\uFB1D-\uFB4F\u0370-\u03FF\u1F00-\u1FFF]/.test(text);

export default function tsv7_ult_quotes_to_origl_quotes(book, tsvContent, dcsUrl = 'https://git.door43.org') {
  return new Promise((resolve, reject) => {
    let output = [];
    let errors = [];

    const testament = BibleBookData[book.toLowerCase()]?.testament;
    if (!testament) {
      const errorMsg = `ERROR: Book ${book} not a valid Bible book`;
      console.error(errorMsg);
      reject(errorMsg);
    }

    getDocuments(book, dcsUrl)
      .then(async () => {
        // Query Proskomma which now contains the books
        if (!tokenLookup?.ult?.[book.toUpperCase()] || !tokenLookup[testament === 'old' ? 'uhb' : 'ugnt']?.[book.toUpperCase()]) {
          await doAlignmentQuery();
        }
        let nRecords = 0;
        let counts = { pass: 0, fail: 0 };
        const tsvRecords = parseTsvToObjects(tsvContent);
        for (const tsvRecord of tsvRecords) {
          nRecords++;
          if (!tsvRecord.ref || !tsvRecord.quote?.trim() || !tsvRecord.occurrence || tsvRecord.ref == 'Reference' || containsHebrewOrGreek(tsvRecord.quote)) {
            // Last condition checks for Greek or Hebrew characters. If they exist, we don't need to process this record since not an English ULT quote
            output.push(tsvRecordToString(tsvRecord));
            continue;
          }
          tsvRecord.quote = tsvRecord.quote.replace('QUOTE_NOT_FOUND: ', '');
          const [chapter, verseRef] = tsvRecord.ref.split(':');
          console.log(`chapter: ${chapter}, verseRef: ${verseRef}`);
          const verses = [];
          const verseCommaParts = verseRef.trim().split(',');
          console.log("CHAPTER: ", chapter, verseRef);
          console.log("verseCommaParts:", verseCommaParts);
          for (const commaPart of verseCommaParts) {
            if (commaPart.includes('-')) {
              const verseRange = commaPart.trim().split('-');
              if (verseRange.length > 1) {
                for (let i = parseInt(verseRange[0]); i <= parseInt(verseRange[1]); i++) {
                  verses.push(i);
                }
              }
            } else {
              verses.push(parseInt(commaPart));
            }
          }
          console.log('VERSES:', verses);
          for (const verseIdx in verses) {
            const verse = verses[verseIdx];
            const cv = `${chapter}:${verse}`;
            const source = testament === 'old' ? tokenLookup.uhb : tokenLookup.ugnt;
            const sourceTokens = source[book.toUpperCase()][cv];
            const allULTTokens = tokenLookup['ult'][book.toUpperCase()][cv];
            const wordLikeULTTokens = allULTTokens?.filter((t) => t.subType === 'wordLike').map(({ subType, position, ...rest }) => rest);

            const cleanQuote = tsvRecord.quote.replace(/&/g, '…').replace(/[{}]/g, '');
            const cleanQuoteUC = cleanQuote.replace(/([a-z])/, (match) => match.toUpperCase());

            const quotesToTry = [cleanQuote];
            if (tsvRecord.quote != cleanQuote) {
              quotesToTry.push(tsvRecord.quote);
            }
            if (cleanQuote.includes('…')) {
              quotesToTry.push(cleanQuote.split(/ *… */));
              if (tsvRecord.quote != cleanQuote) {
                quotesToTry.push(tsvRecord.quote.split(/ *… */));
              }
            }
            if (cleanQuote != cleanQuoteUC) {
              quotesToTry.push(cleanQuoteUC);
              if (cleanQuoteUC.includes('…')) {
                quotesToTry.push(cleanQuoteUC.split(/ *… */));
              }
            }

            let resultObject = null;
            for (const quote of quotesToTry) {
              if (typeof quote === 'string') {
                resultObject = origLFromGLQuote(book, cv, sourceTokens, wordLikeULTTokens, quote, tsvRecord.occurrence, prune);
                if ('data' in resultObject) {
                  break;
                }
              } else if (Array.isArray(quote)) {
                const partsConverted = [];
                for (const part of quote) {
                  resultObject = origLFromGLQuote(book, cv, sourceTokens, wordLikeULTTokens, part, tsvRecord.occurrence, prune);
                  if (!('data' in resultObject)) {
                    resultObject = origLFromGLQuote(
                      book,
                      cv,
                      sourceTokens,
                      wordLikeULTTokens,
                      part.replace(/([a-z])/, (match) => match.toUpperCase()),
                      tsvRecord.occurrence,
                      prune
                    );
                    if (!('data' in resultObject)) {
                      break;
                    }
                  }
                  partsConverted.push(getTidiedData(resultObject.data));
                }
                if (partsConverted.length === quote.length) {
                  resultObject.data = [partsConverted.join(' & ')];
                  break;
                }
              }
            }

            if ('data' in resultObject) {
              console.assert(!resultObject.error);
              counts.pass++;
              tsvRecord.quote = getTidiedData(resultObject.data);
              output.push(tsvRecordToString(tsvRecord));
              break;
            } else {
              if (verseIdx < verses.length - 1) {
                continue;
              }
              tsvRecord.quote = 'QUOTE_NOT_FOUND: ' + tsvRecord.quote;
              output.push(tsvRecordToString(tsvRecord));
              counts.fail++;
              const errorMsg = `Error: ${book} ${cv} ${tsvRecord.id} ${resultObject.error}`;
              console.error(errorMsg);
              errors.push(errorMsg);
            }
          }
        }
        resolve({ output, errors });
      })
      .catch((err) => {
        console.error(err);
        reject(err);
      });
  });
}
