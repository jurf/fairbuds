
            var f_69a8655b1e232 = (dataset) => {
                dataset.data = JSON.parse(atob(dataset.data)).map(({ x, y }) => {
                    return {
                        x: Math.exp(x),
                        y: (y - 4) / 1
                    };
                });

                return dataset;
            };
        