
            var f_69a8655b1c33c = (dataset) => {
                dataset.data = JSON.parse(atob(dataset.data)).map(({ x, y }) => {
                    return {
                        x: Math.exp(x),
                        y: (y - 5) / 1
                    };
                });

                return dataset;
            };
        