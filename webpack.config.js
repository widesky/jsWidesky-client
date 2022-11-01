const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = (env, argv) => {

    const conf = {
        mode: 'development',
        devServer: {
            open: true,
            openPage: [`client/example.html`],
            contentBase: path.join(__dirname, '/'),
            watchContentBase: true,
            port: 8080,
            host: argv.mode === 'production' ? `localhost` : `localhost`,
            disableHostCheck: true,
        },

        entry: {
           'wideskyClient': [`./index.js`],
        },
        // library building properties for (1-1)
        output: {
            path: path.join(__dirname, '/dist/'),
            filename: argv.mode === 'production' ? `[name].min.js` : `[name].develop.js`,
            libraryTarget: 'umd',
            globalObject: 'this',
        },
        optimization: {
            minimizer: [new TerserPlugin({
                terserOptions: {
                    compress: {
                        drop_console: true,
                    },
                }
            })],
        },
        module: {
            rules: [{
                test: /\.js$/,
                exclude: /(node_modules|bower_components)/,
                use: [{
                    loader: 'babel-loader',
                }]
            }]
        },
        resolve: {
            fallback: {
                fs: false,
                net: false,
                tls: false,
                url: false,
                http: false,
                stream: false,
                assert: false,
                zlib: false,
                buffer: false,
                https: false
            }
        }
    };

    if (argv.mode !== 'production') {
        conf.devtool = 'inline-source-map';
    }

    return conf;

};
