const axios = require("axios")

class NPToken {
    constructor({apiKey} ) {
        this.apiKey = apiKey;
        this.authzApiClient =axios.create({
            baseURL:"https://api.nullplatform.com",
            timeout: 10*1000
        })
        this.fullToken = undefined;
    }

    async getToken() {
        if(!this.fullToken) {
            const resp = await this.authzApiClient.post("/token",{
                apikey: this.apiKey
            })
            if(resp.status != 200) {
                throw new Error(`Error getting token [${resp.body && resp.body.constructor === Object? JSON.stringify(resp.body): resp.body}]`);
            }
            this.fullToken = resp.data;
        } else if(this.fullToken?.token_expires_at - 10000 < new Date().getTime()) { //At least 10 seconds before expire
            const resp = await this.authzApiClient.post({
                refresh_token: this.fullToken?.refresh_token,
                organization_id: this.fullToken?.organization_id
            })
            if(resp.status != 200) {
                //Clear token if fails
                this.fullToken = undefined;
                throw new Error(`Error getting token [${resp.body && resp.body.constructor === Object? JSON.stringify(resp.body): resp.body}]`);
            }
            this.fullToken.access_token = resp.data?.access_token;
            this.fullToken.token_expires_at = resp.data?.token_expires_at;
        }

        return this.fullToken?.access_token;
    }
}


module.exports = {NPToken};
