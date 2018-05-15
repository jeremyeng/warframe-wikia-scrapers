'use strict';

const axios = require('axios');
const cmd = require('node-cmd');
const fs = require('fs-extra');
const cheerio = require('cheerio');
const _ = require('lodash');

const transformWeapon = require('./transformers/transformWeapon');

const getLuaData = async category => {
  try {
    const { data } = await axios.get(
      `http://warframe.wikia.com/wiki/Module:${category}/data?action=edit`
    );
    const $ = cheerio.load(data);
    return $('#wpTextbox1').text();
  } catch (err) {
    console.error('Failed to fetch latest weapon data:');
    console.error(err);
    return '';
  }
};

const convertdataToJSON = async luaData => {
  const scriptlines = luaData.split('\n');
  const dataCategory = luaData.match(/(\w+)Data/)[0];

  // Remove return statement
  const modifiedScript = scriptlines
    .slice(0, scriptlines.length - 2)
    .join('\n');

  // Add JSON conversion
  const luaToJsonScript = `
    JSON = (loadfile "JSON.lua")()\n
    ${modifiedScript}\n
    print(JSON:encode(${dataCategory}))
    `;

  // Run updated JSON lua script
  if (!(await fs.exists('./tmp'))) {
    await fs.mkdir('./tmp');
  }
  await fs.writeFile(`./tmp/${dataCategory}ToJson.lua`, luaToJsonScript, {
    encoding: 'utf8',
    flag: 'w'
  });

  try {
    await new Promise((resolve, reject) =>
      cmd.get(
        `lua ./tmp/${dataCategory}ToJson.lua > ./tmp/${dataCategory}Raw.json`,
        err => {
          if (!err) {
            resolve();
          } else {
            reject(err);
            throw new Error(err);
          }
        }
      )
    );
  } catch (err) {
    console.error('Failed to execute modified lua script:');
    console.error(err);
  }
  const rawData = await fs.readFile(`./tmp/${dataCategory}Raw.json`, 'UTF-8');
  return rawData;
};

const getImageURLs = async category => {
  const titles = [];
  Object.keys(category).forEach(name => {
    titles.push(`File:${category[name].Image}`);
  });

  // Split titles into batches of 50, the max allowed by the wikimedia API
  const titleBatches = [];
  while (titles.length > 0) {
    titleBatches.push(titles.splice(0, 50));
  }

  const urlRequests = titleBatches.map(titleBatch =>
    axios.get('http://warframe.wikia.com/api.php', {
      params: {
        action: 'query',
        titles: titleBatch.join('|'),
        prop: 'imageinfo',
        iiprop: 'url',
        format: 'json'
      }
    })
  );

  try {
    const fetchedImageUrls = await Promise.all(urlRequests).then(res => {
      const urls = {};
      res.forEach(({ data }) => {
        Object.keys(data.query.pages).forEach(id => {
          if (id > -1) {
            const title = data.query.pages[id].title.replace('File:', '');
            const { url } = data.query.pages[id].imageinfo[0];
            urls[title] = url;
          }
        });
      });
      return urls;
    });

    return fetchedImageUrls;
  } catch (err) {
    console.error('Failed to fetch image URLs:');
    console.error(err);
    return [];
  }
};

const replaceImageURLs = (data, imageUrls) => {
  return _.mapValues(data, value => {
    const { Image, ...rest } = value;
    if (imageUrls[Image]) {
      const newImageURL = imageUrls[Image];
      return { Image: newImageURL, ...rest };
    } else {
      return value;
    }
  });
};

// Category is either "Warframes", "Weapons", "Mods"
const buildJSON = async category => {
  const luaData = await getLuaData(category);
  const rawData = JSON.parse(await convertdataToJSON(luaData));
  const imageUrls = await getImageURLs(rawData[category]);
  const dataWithFixedImageURLs = replaceImageURLs(rawData[category], imageUrls);
  return dataWithFixedImageURLs;
};

async function main() {
  const [warframeData, weaponData, modData] = await Promise.all([
    buildJSON('Warframes'),
    buildJSON('Weapons'),
    buildJSON('Mods')
  ]);

  if (!(await fs.exists('./build'))) {
    await fs.mkdir('./build');
  }
  fs.writeFile('./build/warframeDataFinal.json', JSON.stringify(warframeData));
  fs.writeFile('./build/weaponDataFinal.json', JSON.stringify(weaponData));
  fs.writeFile('./build/modDataFinal.json', JSON.stringify(modData));
  fs.remove('./tmp');
}

main();
