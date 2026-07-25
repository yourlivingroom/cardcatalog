import cardcatolog from './index.mjs';

const { catalogs } = cardcatolog({
    topLevelKeys: {
        valueEncoding: 'json',
        process: (content, emit) => {
            content = content.toString('utf8');
            for (const word of content.split(/\s/g)) {
                emit(word, true);
            }
        }
    }
});

await new Promise(r => setTimeout(r, 1000));

(async function main() {
    for await (const x of catalogs.topLevelKeys.getMany('foo')) {
        console.log(x);
    }
    console.log(await catalogs.topLevelKeys.get('foo'));
})().catch(console.error);
